import http from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRpApp } from "../src/http/server.js";

/**
 * The relying party's own HTTP surface: `createRpApp` now runs RFC 8414 discovery against
 * `gatewayUrl` at start-up, so these tests stand a tiny fake authorization server up front
 * that answers only `/.well-known/oauth-authorization-server` — enough for discovery to
 * succeed — since none of the routes exercised here (`/`, an unknown `/callback` state, an
 * unknown `/refresh` session) ever reaches the token endpoint or the JWKS.
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

describe("GET /callback", () => {
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
