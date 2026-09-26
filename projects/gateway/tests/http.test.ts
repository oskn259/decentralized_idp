import { KeyObject, generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { calculateJwkThumbprint, createDPoPProof, exportDPoPJwk, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { assembleJwt, createSigningInput, decodeJwt } from "@decentralized-idp/sdk/jwt";
import { assertionJwt } from "@decentralized-idp/sdk/tokens";
import { Gateway } from "../src/domain/usecase/gateway.js";
import { createDemoLog } from "../src/http/demo-log.js";
import { createGatewayServer } from "../src/http/server.js";
import { TestClock } from "./helpers/clock.js";
import { FakeNode } from "./helpers/fake-node.js";
import { TempDist, makeTempDist } from "./helpers/temp-dist.js";

/**
 * What the gateway does when nodes misbehave, seen from its HTTP surface: exclusion, quorum,
 * error codes, a commitment that is not a curve point. The fake nodes inject the failures
 * real nodes would not produce. Client authentication is seen from an attacker's side: no
 * assertion, a key that is not registered, a code issued to another client. The one
 * static-file test guards the directory boundary.
 */

const RP_ORIGIN = "http://localhost:5173";
const ISSUER = "http://localhost:3000";
const GROUP_PUBLIC_KEY = new Uint8Array(32).fill(9);
const NOW = 1_700_000_000;

/** An Ed25519 key from node:crypto, so client assertions are signed independently of the sdk. */
function clientKey(): { publicKey: Uint8Array; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: base64UrlDecode(publicKey.export({ format: "jwk" }).x!), privateKey };
}

/** The key registered for `demo_client`. */
const DEMO_CLIENT_KEY = clientKey();

/** A `private_key_jwt` assertion as openid-client builds it. */
function signClientAssertion(privateKey: KeyObject, clientId = "demo_client"): string {
  const { signingInput, headerB64, payloadB64 } = createSigningInput({
    header: { alg: "EdDSA" },
    payload: { iss: clientId, sub: clientId, aud: ISSUER, jti: crypto.randomUUID(), iat: NOW, nbf: NOW, exp: NOW + 60 },
  });
  return assembleJwt(headerB64, payloadB64, sign(null, signingInput, privateKey));
}

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
    clients: [{ clientId: "demo_client", publicKey: DEMO_CLIENT_KEY.publicKey }],
    clock: new TestClock(NOW),
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

/**
 * An assertion for a fresh DPoP key, a proof from that key, and `demo_client`'s client
 * assertion. The gateway never verifies the code's signature, so any 64 bytes serve.
 */
function clientCredential(codeClientId = "demo_client"): {
  credential: string;
  proof: string;
  jkt: string;
  foreignProof: string;
  clientAssertion: string;
} {
  const keyPair = generateDPoPKeyPair();
  const jkt = calculateJwkThumbprint(exportDPoPJwk(keyPair.publicKey));
  const jwt = assertionJwt({ issuer: ISSUER, keyId: "pasta-group-key-1" }, "usr_test", {
    clientId: codeClientId,
    scope: "openid",
    cnfJkt: jkt,
    iat: NOW,
    exp: NOW + 30,
  });
  const { headerB64, payloadB64 } = createSigningInput(jwt);
  return {
    credential: assembleJwt(headerB64, payloadB64, new Uint8Array(64)),
    proof: createDPoPProof(keyPair, "POST", `${ISSUER}/token`, NOW),
    jkt,
    foreignProof: createDPoPProof(generateDPoPKeyPair(), "POST", `${ISSUER}/token`, NOW),
    clientAssertion: signClientAssertion(DEMO_CLIENT_KEY.privateKey),
  };
}

/** `clientAssertion` travels as `client_assertion` with the jwt-bearer type; left out, the client does not authenticate. */
async function postToken(form: Record<string, string>, dpop?: string, clientAssertion?: string): Promise<Response> {
  const body = new URLSearchParams(form);
  if (clientAssertion !== undefined) {
    body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    body.set("client_assertion", clientAssertion);
  }
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (dpop !== undefined) headers.DPoP = dpop;
  return fetch(`${server!.url}/token`, { method: "POST", headers, body });
}

describe("POST /api/pasta/sign-on across the nodes", () => {
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

  async function signOn(): Promise<Response> {
    return fetch(`${server!.url}/api/pasta/sign-on`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });
  }

  it("excludes a node that fails round 1, keeps participants ascending, and sends that set to round 2", async () => {
    // `nodes` is deliberately unsorted: the ascending order must be the gateway's own.
    const nodes = [new FakeNode(3), new FakeNode(1), new FakeNode(2, { commitFails: true })];
    server = await startTestServer(nodes, dist);

    const res = await signOn();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commitments.map((c: { nodeId: number }) => c.nodeId)).toEqual([1, 3]);
    expect(body.shares.map((s: { nodeId: number }) => s.nodeId)).toEqual([1, 3]);

    const [node3, node1, node2] = nodes;
    expect(node1.signOnCalls[0].allParticipants).toEqual([1, 3]);
    expect(node1.signOnCalls[0].commitments.map((c) => c.nodeId)).toEqual([1, 3]);
    expect(node3.signOnCalls).toHaveLength(1);
    expect(node2.commitCalls).toHaveLength(1);
    expect(node2.signOnCalls).toHaveLength(0);
    expect(server.logLines.some((l) => l.includes("(node2 unreachable, excluded)"))).toBe(true);
  });

  it("400s with the documented quorum message, naming every unreachable node, when two of three are down", async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2, { commitFails: true }), new FakeNode(3, { commitFails: true })], dist);
    const res = await signOn();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("quorum 1 < 2 (node2, node3 unreachable)");
    expect(server.logLines.some((l) => l.includes("✖ sign-on rejected: quorum 1 < 2"))).toBe(true);
  });
});

describe("POST /token across the nodes", () => {
  it("answers the token set aggregated from every node's share, bound to the code's DPoP key", async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
    const { credential, proof, jkt, clientAssertion } = clientCredential();

    const res = await postToken({ grant_type: "authorization_code", code: credential }, proof, clientAssertion);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe("DPoP");
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe("openid");

    const at = decodeJwt(body.access_token);
    expect(at.header.typ).toBe("at+jwt");
    expect(at.payload.aud).toBe("demo_client");
    expect(at.payload.cnf).toEqual({ jkt });
    expect((at.payload.exp as number) - (at.payload.iat as number)).toBe(3600);
    const rt = decodeJwt(body.refresh_token);
    expect(rt.header.typ).toBe("refresh+jwt");
    expect(rt.payload.cnf).toEqual({ jkt });
    expect(server.logLines.some((l) => l.includes("→ 2×/commit ×3 → /sign → access_token"))).toBe(true);
  });

  it("relays a refresh_token grant to the nodes as such", async () => {
    const nodes = [new FakeNode(1), new FakeNode(2), new FakeNode(3)];
    server = await startTestServer(nodes, dist);
    const { credential, proof, clientAssertion } = clientCredential();

    const res = await postToken({ grant_type: "refresh_token", refresh_token: credential }, proof, clientAssertion);
    expect(res.status).toBe(200);
    expect(nodes[0].signCalls[0].grant).toBe("refresh_token");
  });

  it("excludes a node that fails round 1 and still answers while quorum holds", async () => {
    const nodes = [new FakeNode(1), new FakeNode(2, { commitFails: true }), new FakeNode(3)];
    server = await startTestServer(nodes, dist);
    const { credential, proof, clientAssertion } = clientCredential();

    const res = await postToken({ grant_type: "authorization_code", code: credential }, proof, clientAssertion);
    expect(res.status).toBe(200);
    expect(nodes[0].signCalls[0].allParticipants).toEqual([1, 3]);
    expect(nodes[1].signCalls).toHaveLength(0);
    expect(server.logLines.some((l) => l.includes("(node2 unreachable, excluded)"))).toBe(true);
  });

  it("400 invalid_grant for a code that is not a JWT", async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
    const { proof, clientAssertion } = clientCredential();
    const res = await postToken({ grant_type: "authorization_code", code: "not-a-jwt" }, proof, clientAssertion);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toContain("credential:");
  });

  it("400 invalid_dpop_proof for a proof from another key, before any round is opened", async () => {
    const nodes = [new FakeNode(1), new FakeNode(2), new FakeNode(3)];
    server = await startTestServer(nodes, dist);
    const { credential, foreignProof, clientAssertion } = clientCredential();

    const res = await postToken({ grant_type: "authorization_code", code: credential }, foreignProof, clientAssertion);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_dpop_proof");
    for (const node of nodes) expect(node.commitCalls).toEqual([]);
  });

  it("400 invalid_grant carrying the node's reason when a node refuses to sign", async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2, { signFails: "node 2 rejects: bad credential" }), new FakeNode(3)], dist);
    const { credential, proof, clientAssertion } = clientCredential();

    const res = await postToken({ grant_type: "authorization_code", code: credential }, proof, clientAssertion);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toContain("node 2 rejects: bad credential");
  });

  it("400 invalid_grant when quorum is lost", async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2, { commitFails: true }), new FakeNode(3, { commitFails: true })], dist);
    const { credential, proof, clientAssertion } = clientCredential();

    const res = await postToken({ grant_type: "authorization_code", code: credential }, proof, clientAssertion);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toContain("quorum 1 < 2");
  });
});

describe("POST /token client authentication", () => {
  beforeEach(async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2), new FakeNode(3)], dist);
  });

  it("400 invalid_client without a client assertion", async () => {
    const { credential, proof } = clientCredential();
    const res = await postToken({ grant_type: "authorization_code", code: credential }, proof);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("400 invalid_client for an assertion naming demo_client but signed by a key it did not register", async () => {
    const { credential, proof } = clientCredential();
    const forged = signClientAssertion(clientKey().privateKey);
    const res = await postToken({ grant_type: "authorization_code", code: credential }, proof, forged);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("400 invalid_grant for a code issued to another client, before any round is opened", async () => {
    const { credential, proof, clientAssertion } = clientCredential("other_client");
    const res = await postToken({ grant_type: "authorization_code", code: credential }, proof, clientAssertion);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant", error_description: "credential was issued to another client" });
    for (const node of server!.gateway.nodes as FakeNode[]) expect(node.commitCalls).toEqual([]);
  });
});

describe("GET /authorize from an unregistered client", () => {
  it("400 unauthorized_client without following its redirect_uri", async () => {
    server = await startTestServer([new FakeNode(1)], dist, 1);
    const query = new URLSearchParams({
      client_id: "evil_client",
      redirect_uri: "https://evil.example/cb",
      response_type: "code",
      scope: "openid",
      state: "st",
      dpop_jkt: "A".repeat(43),
    });
    const res = await fetch(`${server.url}/authorize?${query}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toEqual({ error: "unauthorized_client", error_description: "unknown client_id evil_client" });
  });
});

describe("POST /token with a corrupt commitment", () => {
  beforeEach(async () => {
    server = await startTestServer([new FakeNode(1), new FakeNode(2, { commitCorrupt: true }), new FakeNode(3)], dist);
  });

  it("400 invalid_request when a node's commitment cannot be aggregated (not an OAuthError)", async () => {
    // A commitment that is not a curve point makes the aggregation itself throw a plain
    // Error, which is not one of the failures issueTokens maps to an OAuthError.
    const { credential, proof, clientAssertion } = clientCredential();
    const res = await postToken({ grant_type: "authorization_code", code: credential }, proof, clientAssertion);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
  });
});

describe("static login page", () => {
  beforeEach(async () => {
    server = await startTestServer([new FakeNode(1)], dist, 1);
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
