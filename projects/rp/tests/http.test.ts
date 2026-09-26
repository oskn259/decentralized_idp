import http from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRpApp } from "../src/http/server.js";

/**
 * The relying party's own HTTP surface, against a tiny fake authorization server: it
 * answers RFC 8414 discovery (which `createRpApp` runs at start-up) and refuses every code
 * at `/token`, so the relying party's handling of the gateway's refusals can be seen
 * without a gateway. Real tokens are `../e2e`'s job.
 */

const CLIENT_ID = "demo_client";
const SCOPE = "profile";
const RP_URL = "http://rp.test";

let fakeGateway: http.Server;
let gatewayUrl: string;
let app: Hono;

function metadataFor(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    dpop_signing_alg_values_supported: ["EdDSA"],
    scopes_supported: ["profile", "email"],
    code_challenge_methods_supported: [],
  };
}

beforeAll(async () => {
  fakeGateway = http.createServer((req, res) => {
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(metadataFor(gatewayUrl)));
      return;
    }
    if (req.url === "/token") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "the code did not verify" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    fakeGateway.once("error", reject);
    fakeGateway.listen(0, "127.0.0.1", () => {
      fakeGateway.removeListener("error", reject);
      resolve();
    });
  });
  gatewayUrl = `http://127.0.0.1:${(fakeGateway.address() as AddressInfo).port}`;
  app = await createRpApp({ gatewayUrl, rpUrl: RP_URL, clientId: CLIENT_ID, scope: SCOPE });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    fakeGateway.closeAllConnections();
    fakeGateway.close(() => resolve());
  });
});

describe("GET /", () => {
  it("shows a Sign in link", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('href="/login"');
    expect(text).toContain("Sign in");
  });
});

describe("GET /login", () => {
  it("302s to the gateway's /authorize with every required field and a fresh DPoP thumbprint", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe(`${gatewayUrl}/authorize`);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${RP_URL}/callback`);
    expect(location.searchParams.get("scope")).toBe(SCOPE);
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(location.searchParams.get("dpop_jkt")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("draws a different state and thumbprint every time", async () => {
    const first = new URL((await app.request("/login")).headers.get("location") as string);
    const second = new URL((await app.request("/login")).headers.get("location") as string);
    expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
    expect(first.searchParams.get("dpop_jkt")).not.toBe(second.searchParams.get("dpop_jkt"));
  });
});

/** `/login`'s redirect carries the state the relying party will accept back on `/callback`. */
async function freshState(): Promise<string> {
  const location = new URL((await app.request("/login")).headers.get("location") as string);
  return location.searchParams.get("state") as string;
}

describe("GET /callback", () => {
  it("shows the gateway's refusal of the code with 400", async () => {
    const state = await freshState();
    const res = await app.request(`/callback?code=whatever&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_grant: the code did not verify");
  });

  it("shows the gateway's /authorize refusal, carried back as error and state, with 400", async () => {
    const state = await freshState();
    const res = await app.request(`/callback?error=invalid_request&error_description=scope%3A+is+required&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_request: scope: is required");
  });

  it("refuses an unknown state with 400", async () => {
    const res = await app.request("/callback?code=whatever&state=nobody-asked");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unknown state");
  });

  it("refuses a missing state with 400", async () => {
    const res = await app.request("/callback?code=whatever");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unknown state");
  });
});

describe("POST /refresh", () => {
  it("refuses an unknown session with 400", async () => {
    const res = await app.request("/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ session: "nobody" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unknown session");
  });

  it("refuses a missing session with 400", async () => {
    const res = await app.request("/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unknown session");
  });
});
