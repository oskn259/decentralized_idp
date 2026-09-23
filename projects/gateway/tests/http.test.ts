import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { calculateJwkThumbprint, createDPoPProof, exportDPoPJwk, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { assembleJwt, createSigningInput } from "@decentralized-idp/sdk/jwt";
import { assertionJwt } from "@decentralized-idp/sdk/tokens";
import { Gateway } from "../src/domain/usecase/gateway.js";
import { createDemoLog } from "../src/http/demo-log.js";
import { createGatewayServer } from "../src/http/server.js";
import { TestClock } from "./helpers/clock.js";
import { FakeNode } from "./helpers/fake-node.js";
import { TempDist, makeTempDist } from "./helpers/temp-dist.js";

/**
 * The HTTP surface the gateway itself owns, against fake `Node`s: routing, refusals,
 * metadata and JWKS content, CORS, the static login page. Sign-on and token success paths
 * run against real nodes in e2e.test.ts.
 */

const RP_ORIGIN = "http://localhost:5173";
const ISSUER = "http://localhost:3000";
const GROUP_PUBLIC_KEY = new Uint8Array(32).fill(9);

interface TestServer {
  url: string;
  gateway: Gateway;
  logLines: string[];
  close(): Promise<void>;
}

async function startTestServer(nodes: FakeNode[], dist: TempDist, threshold = 2): Promise<TestServer> {
  const gateway: Gateway = {
    group: { issuer: ISSUER, threshold, groupPublicKey: GROUP_PUBLIC_KEY, keyId: "pasta-group-key-1" },
    nodes,
    clock: new TestClock(1_700_000_000),
  };
  const logLines: string[] = [];
  const demo = createDemoLog({ env: { DEMO_LOG: "1" }, isTty: false, write: (l) => logLines.push(l) });
  const server = createGatewayServer(gateway, demo, { loginDist: dist.dir, rpOrigin: RP_ORIGIN });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    gateway,
    logLines,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

let dist: TempDist;
let server: TestServer | undefined;

beforeEach(() => {
  dist = makeTempDist();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  dist.cleanup();
});

describe("GET /health", () => {
  it("answers 200 with every node when all are healthy", async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.nodes).toHaveLength(3);
    expect(body.nodes.every((n: { healthy: boolean }) => n.healthy)).toBe(true);
  });

  it("answers 503 degraded when fewer than the threshold answer", async () => {
    server = await startTestServer(
      [new FakeNode(1), new FakeNode(2, { healthFails: true }), new FakeNode(3, { healthFails: true })],
      dist,
      2
    );
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.nodes.filter((n: { healthy: boolean }) => n.healthy)).toHaveLength(1);
    expect(body.nodes.find((n: { nodeId: number }) => n.nodeId === 2).healthy).toBe(false);
  });
});

describe("GET /.well-known/openid-configuration", () => {
  it("advertises authorization_code + DPoP, no id_token", async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
    const res = await fetch(`${server.url}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      dpop_signing_alg_values_supported: ["EdDSA"],
      scopes_supported: ["openid", "profile", "email"],
    });
  });
});

describe("GET /jwks.json", () => {
  it("publishes the one Ed25519 group key and allows the rp origin cross-origin", async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
    const res = await fetch(`${server.url}/jwks.json`, { headers: { Origin: RP_ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(RP_ORIGIN);
    const body = await res.json();
    expect(body).toEqual({
      keys: [{ kty: "OKP", crv: "Ed25519", x: base64UrlEncode(GROUP_PUBLIC_KEY), kid: "pasta-group-key-1", use: "sig", alg: "EdDSA" }],
    });
  });

  it("does not grant CORS to a different origin", async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
    const res = await fetch(`${server.url}/jwks.json`, { headers: { Origin: "http://evil.example" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("OPTIONS /token", () => {
  it("preflights with the rp origin and exposes DPoP in Access-Control-Allow-Headers", async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
    const res = await fetch(`${server.url}/token`, {
      method: "OPTIONS",
      headers: {
        Origin: RP_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "DPoP, Content-Type",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(RP_ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toContain("DPoP");
  });
});

describe("GET /authorize", () => {
  async function authorize(query: Record<string, string>): Promise<Response> {
    const url = new URL(`${server!.url}/authorize`);
    url.search = new URLSearchParams(query).toString();
    return fetch(url, { redirect: "manual" });
  }

  const VALID = { client_id: "demo_client", redirect_uri: "http://localhost:5173/cb", response_type: "code", scope: "openid profile", dpop_jkt: "a".repeat(43) };

  beforeEach(async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
  });

  it("400s when client_id is missing", async () => {
    const { client_id, ...rest } = VALID;
    const res = await authorize(rest);
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toBe("client_id: is required");
  });

  it("400s when redirect_uri is missing", async () => {
    const { redirect_uri, ...rest } = VALID;
    const res = await authorize(rest);
    expect((await res.json()).error_description).toBe("redirect_uri: is required");
  });

  it("400s when response_type is not code", async () => {
    const res = await authorize({ ...VALID, response_type: "token" });
    expect((await res.json()).error_description).toBe("response_type: must be code");
  });

  it("400s when scope does not include openid", async () => {
    const res = await authorize({ ...VALID, scope: "profile" });
    expect((await res.json()).error_description).toBe("scope: must include openid");
  });

  it("400s the same way when scope is absent entirely", async () => {
    const { scope, ...rest } = VALID;
    const res = await authorize(rest);
    expect((await res.json()).error_description).toBe("scope: is required");
  });

  it("400s when dpop_jkt is not a 43-character base64url thumbprint", async () => {
    const res = await authorize({ ...VALID, dpop_jkt: "too-short" });
    expect((await res.json()).error_description).toBe("dpop_jkt: must be a base64url SHA-256 JWK thumbprint (43 characters)");
  });

  it("every 400 is invalid_request and logged as a rejection", async () => {
    const { client_id, ...rest } = VALID;
    const res = await authorize(rest);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(server!.logLines.some((l) => l.includes("✖ authorize rejected: client_id: is required"))).toBe(true);
  });

  it("302s to /login carrying c, client_id, redirect_uri, scope, state and dpop_jkt", async () => {
    const res = await authorize({ ...VALID, state: "xyz" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!, server!.url);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("client_id")).toBe(VALID.client_id);
    expect(location.searchParams.get("redirect_uri")).toBe(VALID.redirect_uri);
    expect(location.searchParams.get("scope")).toBe(VALID.scope);
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("dpop_jkt")).toBe(VALID.dpop_jkt);
    expect(location.searchParams.get("c")).toBeTruthy();
    expect(location.searchParams.get("step")).toBe("login");
  });

  it("defaults state to an empty string when absent", async () => {
    const res = await authorize(VALID);
    const location = new URL(res.headers.get("location")!, server!.url);
    expect(location.searchParams.get("state")).toBe("");
  });
});

describe("POST /api/pasta/sign-on", () => {
  beforeEach(async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
  });

  const VALID = {
    username: "alice",
    blinded: base64UrlEncode(new Uint8Array(32).fill(1)),
    sessionNonce: base64UrlEncode(new Uint8Array(16).fill(2)),
    cnfJkt: "jkt",
    clientId: "demo_client",
    scope: "openid",
    nonce: "n1",
    iat: 1,
    exp: 31,
  };

  async function post(body: unknown, raw?: string): Promise<Response> {
    return fetch(`${server!.url}/api/pasta/sign-on`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    });
  }

  it("400s on a non-JSON body", async () => {
    const res = await post(undefined, "not json at all");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Request body is not valid JSON");
  });

  it.each(["username", "blinded", "sessionNonce", "cnfJkt", "clientId", "nonce"] as const)("400s when %s is missing", async (field) => {
    const { [field]: _omit, ...rest } = VALID;
    const res = await post(rest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain(field);
  });

  it("400s when iat is missing or not an integer", async () => {
    const { iat, ...rest } = VALID;
    const res = await post(rest);
    expect((await res.json()).error).toContain("iat");
  });

  it("400s when exp is missing or not an integer", async () => {
    const { exp, ...rest } = VALID;
    const res = await post(rest);
    expect((await res.json()).error).toContain("exp");
  });

  it("400s when blinded does not decode to 32 bytes", async () => {
    const res = await post({ ...VALID, blinded: base64UrlEncode(new Uint8Array(4)) });
    expect((await res.json()).error).toContain("blinded");
  });

  it("400s when scope is present but not a string", async () => {
    const res = await post({ ...VALID, scope: 5 });
    expect((await res.json()).error).toBe("scope: must be a string");
  });

  it("defaults scope to an empty string when absent", async () => {
    const { scope, ...rest } = VALID;
    const res = await post(rest);
    expect(res.status).toBe(200);
  });
});

async function postToken(form: Record<string, string>, dpop?: string): Promise<Response> {
  const body = new URLSearchParams(form);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (dpop !== undefined) headers.DPoP = dpop;
  return fetch(`${server!.url}/token`, { method: "POST", headers, body });
}

describe("POST /token", () => {
  beforeEach(async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
  });

  it("400 invalid_request for an unsupported grant_type", async () => {
    const res = await postToken({ grant_type: "client_credentials" }, "proof");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("grant_type");
  });

  it("400 invalid_request for a missing grant_type", async () => {
    const res = await postToken({}, "proof");
    expect((await res.json()).error).toBe("invalid_request");
  });

  it("400 invalid_dpop_proof when the DPoP header is missing", async () => {
    const res = await postToken({ grant_type: "authorization_code", code: "abc" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_dpop_proof");
    expect(body.error_description).toContain("DPoP header is required");
  });

  it("400 invalid_request when code is missing for authorization_code", async () => {
    const res = await postToken({ grant_type: "authorization_code" }, "proof");
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toBe("code (authorization_code) or refresh_token (refresh_token) is required");
  });

  it("400 invalid_request when refresh_token is missing for refresh_token grant", async () => {
    const res = await postToken({ grant_type: "refresh_token" }, "proof");
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toBe("code (authorization_code) or refresh_token (refresh_token) is required");
  });

  it("sets Cache-Control: no-store on both success and failure paths", async () => {
    const res = await postToken({ grant_type: "authorization_code" }, "proof");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("logs the refusal with its error code", async () => {
    await postToken({ grant_type: "bogus" }, "proof");
    expect(server!.logLines.some((l) => l.includes("✖ token rejected: grant_type:"))).toBe(true);
  });
});

describe("POST /token with a corrupt commitment", () => {
  beforeEach(async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2, { commitCorrupt: true }), new FakeNode(3)], dist);
  });

  it("400 invalid_request when a node's commitment cannot be aggregated (not an OAuthError)", async () => {
    // A commitment that is not a curve point makes the aggregation itself throw a plain
    // Error, which is not one of the failures issueTokens maps to an OAuthError.
    const keyPair = generateDPoPKeyPair();
    const jkt = calculateJwkThumbprint(exportDPoPJwk(keyPair.publicKey));
    const jwt = assertionJwt({ issuer: ISSUER, keyId: "pasta-group-key-1" }, "usr_test", {
      clientId: "demo_client",
      scope: "openid",
      cnfJkt: jkt,
      iat: 1_700_000_000,
      exp: 1_700_000_030,
    });
    const { headerB64, payloadB64 } = createSigningInput(jwt);
    const credential = assembleJwt(headerB64, payloadB64, new Uint8Array(64));
    const proof = createDPoPProof(keyPair, "POST", `${ISSUER}/token`, 1_700_000_000);

    const res = await postToken({ grant_type: "authorization_code", code: credential }, proof);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
  });
});

describe("404s", () => {
  it("answers a JSON body naming the method and path", async () => {
    server = await startTestServer([new FakeNode(1)], dist, 1);
    const res = await fetch(`${server.url}/no-such-route`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found: GET /no-such-route");
  });
});

describe("static login page", () => {
  beforeEach(async () => {
    server = await startTestServer([new FakeNode(1)], dist, 1);
  });

  it("serves index.html at /", async () => {
    const res = await fetch(`${server!.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>login</title>");
  });

  it("serves index.html at /login", async () => {
    const res = await fetch(`${server!.url}/login`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>login</title>");
  });

  it("serves a file under /assets/", async () => {
    const res = await fetch(`${server!.url}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("console.log('app');");
  });

  it("does not let /assets/../<file> escape the dist directory", async () => {
    const secretPath = path.join(dist.dir, "..", "outside-secret.txt");
    fs.writeFileSync(secretPath, "top secret, never serve me");
    try {
      // fetch() normalizes ".." away before sending, so the request line goes over a bare socket.
      const { port } = new URL(server!.url);
      const raw = await rawGet(Number(port), "/assets/../outside-secret.txt");
      expect(raw.status).not.toBe(200);
      expect(raw.body).not.toContain("top secret");
    } finally {
      fs.rmSync(secretPath, { force: true });
    }
  });
});

/** Sends a request with a literal raw path, bypassing URL normalization of `..` segments. */
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
