import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { FakeClock, TEST_ISSUER, failingSettler, readFixtureJson, testPublicUrl } from "./helpers/build-node.js";
import { DEFAULT_KEY_ID } from "../src/domain/value/node-identity.js";
import {
  ClientSession,
  GATEWAY_ID,
  clientAssertion,
  decodeJwt,
  fixtureUserShares,
  newDPoPKeyPair,
  postSign,
  prepareSign,
  registerBody,
  registerOverHttp,
  signBody,
  signOnOverHttp,
  signOverHttp,
  paymentSignature,
  withAssertion,
} from "./helpers/client.js";
import { FixtureNode, StartNodeOptions, getJson, postJson, startAllNodes, startNodeFromFixture, stopAll } from "./helpers/http-server.js";
import { base64UrlDecode, base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { aggregateSignatureShares, computeGroupCommitment } from "@decentralized-idp/sdk/frost";
import { hexToBytes } from "@decentralized-idp/sdk/hex";
import { assembleJwt, createSigningInput } from "@decentralized-idp/sdk/jwt";
import { blind } from "@decentralized-idp/sdk/toprf";

/**
 * Component end-to-end test: three real node servers on ephemeral ports, exactly as three
 * containers would run, and every protocol message travels over real HTTP. `/register`
 * gives every node its share of alice and bob before any test runs. `/commit` and
 * `/sign-on` build the assertion (the authorization code); `/commit` (twice) and `/sign`
 * turn it into an access token and a refresh token. The nodes share one `FakeClock`, so
 * the 30-second assertion window can be tested without a real 30-second wait. Every `/sign`
 * is sent as the fixture gateway, which pays when a node asks; the chain is a fake settler.
 */

const GROUP = readFixtureJson("group.json");
const GROUP_PUBLIC_KEY = hexToBytes(GROUP.groupPublicKey);
const ISSUER = TEST_ISSUER;
const CLIENT_ID = "demo_client";
const SCOPE = "openid profile";

let nodes: FixtureNode[];
let clock: FakeClock;

beforeAll(async () => {
  clock = new FakeClock(1_700_000_000);
  nodes = await startAllNodes({ clock });
  await registerOverHttp({ nodes, username: "alice", password: "password123", sub: "usr_alice_12345" });
  await registerOverHttp({ nodes, username: "bob", password: "password456", sub: "usr_bob_67890" });
});

afterAll(async () => {
  await stopAll(nodes);
});

function verifyToken(token: string): boolean {
  const [h, p, sig] = token.split(".");
  return ed25519.verify(base64UrlDecode(sig), new TextEncoder().encode(`${h}.${p}`), GROUP_PUBLIC_KEY);
}

function liveSession(overrides: Partial<Parameters<typeof signOnOverHttp>[0]> = {}): Promise<ClientSession> {
  return signOnOverHttp({
    nodes,
    username: "alice",
    password: "password123",
    clientId: CLIENT_ID,
    issuer: ISSUER,
    scope: SCOPE,
    nonce: `c-${crypto.randomUUID()}`,
    now: clock.nowSeconds(),
    ...overrides,
  });
}

/** The servers run on the shared `FakeClock`, so every `/sign` attempt is stamped with its time. */
function sign(params: Parameters<typeof signOverHttp>[0]): ReturnType<typeof signOverHttp> {
  return signOverHttp({ now: clock.nowSeconds(), ...params });
}
function prepare(params: Parameters<typeof prepareSign>[0]): ReturnType<typeof prepareSign> {
  return prepareSign({ now: clock.nowSeconds(), ...params });
}

describe("health", () => {
  it("reports each node's own id and public URL, and the shared group public key", async () => {
    for (const n of nodes) {
      const res = await getJson(n.url, "/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: "ok",
        nodeId: n.nodeId,
        groupPublicKey: base64UrlEncode(GROUP_PUBLIC_KEY),
        publicUrl: testPublicUrl(n.nodeId),
      });
    }
    expect(nodes.map((n) => n.nodeId).sort()).toEqual([1, 2, 3]);
  });
});

describe("register", () => {
  it("refuses a second registration of a username with 409", async () => {
    const share = fixtureUserShares("another-password")[0];
    const res = await postJson(nodes[0].url, "/register", registerBody(share, "alice", "usr_other"));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "username alice is taken" });

    // alice still signs on with her own password and keeps her sub.
    expect(decodeJwt((await liveSession()).assertion).payload.sub).toBe("usr_alice_12345");
  });

  it("refuses with 409 another username claiming alice's sub", async () => {
    const share = fixtureUserShares("pw")[0];
    const res = await postJson(nodes[0].url, "/register", registerBody(share, "carol", "usr_alice_12345"));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "sub usr_alice_12345 is taken" });
  });

  it("lets the login page at the issuer origin call /register cross-origin, and no other origin", async () => {
    const preflight = (origin: string) =>
      fetch(`${nodes[0].url}/register`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
      });
    expect((await preflight(ISSUER)).headers.get("access-control-allow-origin")).toBe(ISSUER);
    expect((await preflight("http://evil.test")).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps registered users across a restart on the same users file", async () => {
    await registerOverHttp({ nodes, username: "erin", password: "password789", sub: "usr_erin" });
    const restarted = await startAllNodes({ clock, usersFiles: nodes.map((n) => n.usersFile) });
    try {
      const session = await liveSession({ nodes: restarted, username: "erin", password: "password789" });
      expect(verifyToken(session.assertion)).toBe(true);
      expect(decodeJwt(session.assertion).payload.sub).toBe("usr_erin");
    } finally {
      await stopAll(restarted);
    }
  });
});

describe("sign-on: the authentication assertion", () => {
  it("signs alice in across all three nodes and verifies the assertion", async () => {
    const session = await liveSession({ nonce: "c-e2e-1" });
    expect(verifyToken(session.assertion)).toBe(true);

    const { header, payload } = decodeJwt(session.assertion);
    expect(header).toEqual({ alg: "EdDSA", typ: "JWT", kid: "pasta-group-key-1" });
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(ISSUER);
    expect(payload.sub).toBe("usr_alice_12345");
    expect(payload.nonce).toBe("c-e2e-1");
    expect(payload.cnf).toEqual({ jkt: session.cnfJkt });
  });

  it("signs bob in too, and every node agrees on the byte-identical payload", async () => {
    const session = await liveSession({ username: "bob", password: "password456", nonce: "c-bob" });
    expect(verifyToken(session.assertion)).toBe(true);
    expect(decodeJwt(session.assertion).payload.sub).toBe("usr_bob_67890");
  });

  it("succeeds with a 2-of-3 quorum, any pair", async () => {
    for (const quorum of [[nodes[0], nodes[1]], [nodes[1], nodes[2]], [nodes[0], nodes[2]]]) {
      const session = await liveSession({ nodes: quorum, nonce: "c-quorum" });
      expect(verifyToken(session.assertion)).toBe(true);
    }
  });

  it("succeeds with the full 3-of-3 quorum", async () => {
    const session = await liveSession({ nodes, nonce: "c-full-quorum" });
    expect(verifyToken(session.assertion)).toBe(true);
  });

  it("fails to decrypt with the wrong password", async () => {
    await expect(liveSession({ password: "WRONG-password", nonce: "c-bad-pw" })).rejects.toThrow(
      /Invalid password or corrupted share/
    );
  });

  it("fails to decrypt when the client assumes a spoofed sub", async () => {
    await expect(liveSession({ nonce: "c-spoof", subOverride: "admin" })).rejects.toThrow(
      /Invalid password or corrupted share/
    );
  });

  it("answers 400 for an unknown user", async () => {
    const roundId = crypto.randomUUID();
    await postJson(nodes[0].url, "/commit", { roundId });
    const res = await postJson(nodes[0].url, "/sign-on", {
      roundId,
      request: {
        username: "mallory",
        blinded: base64UrlEncode(blind("x").blinded.toRawBytes()),
        sessionNonce: base64UrlEncode(crypto.randomBytes(16)),
        cnfJkt: "jkt",
        clientId: CLIENT_ID,
        scope: SCOPE,
        iat: clock.nowSeconds(),
        exp: clock.nowSeconds() + 30,
        commitments: [],
        allParticipants: [1],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("User not found on node 1");
  });

  it("consumes a round nonce once, so a replayed /sign-on is refused", async () => {
    const roundId = crypto.randomUUID();
    const commit = await postJson(nodes[0].url, "/commit", { roundId });
    const request = {
      username: "alice",
      blinded: base64UrlEncode(blind("password123").blinded.toRawBytes()),
      sessionNonce: base64UrlEncode(crypto.randomBytes(16)),
      cnfJkt: "jkt",
      clientId: CLIENT_ID,
      scope: SCOPE,
      iat: clock.nowSeconds(),
      exp: clock.nowSeconds() + 30,
      commitments: [{ nodeId: 1, D: commit.body.D, E: commit.body.E }],
      allParticipants: [1],
    };

    const first = await postJson(nodes[0].url, "/sign-on", { roundId, request });
    expect(first.status).toBe(200);
    const replay = await postJson(nodes[0].url, "/sign-on", { roundId, request });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toContain("expired or not found");
  });
});

describe("access token over HTTP", () => {
  it("mints an access token bound to the DPoP key and a refresh token, aggregated from plaintext shares", async () => {
    const session = await liveSession();
    const { access_token, refresh_token, atPayload, rtPayload, shares, refreshShares } = await sign({ nodes, session });

    expect(shares).toHaveLength(3);
    expect(refreshShares).toHaveLength(3);
    expect(shares.every((z) => /^[0-9a-f]{64}$/.test(z))).toBe(true);

    expect(verifyToken(access_token)).toBe(true);
    const { header, payload } = decodeJwt(access_token);
    expect(header).toEqual({ alg: "EdDSA", typ: "at+jwt", kid: "pasta-group-key-1" });
    expect(payload).toEqual(atPayload);
    expect(payload.aud).toBe(CLIENT_ID);
    expect(payload.cnf).toEqual({ jkt: session.cnfJkt });
    expect(payload.exp - payload.iat).toBe(3600);

    expect(verifyToken(refresh_token)).toBe(true);
    const rt = decodeJwt(refresh_token);
    expect(rt.header).toEqual({ alg: "EdDSA", typ: "refresh+jwt", kid: "pasta-group-key-1" });
    expect(rt.payload).toEqual(rtPayload);
    expect(rt.payload.exp - rt.payload.iat).toBe(86400 * 30);
  });

  it("refuses a tampered assertion", async () => {
    const session = await liveSession();
    const [h, p, sig] = session.assertion.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.sub = "usr_bob_67890";
    const forged = `${h}.${base64UrlEncode(JSON.stringify(payload))}.${sig}`;

    const attempt = await prepare({ nodes: [nodes[0]], session, assertionOverride: forged });
    const res = await postSign(nodes[0], signBody(attempt));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid Ed25519 signature");
  });

  it("signs on a 2-of-3 subset of the nodes that saw the sign-on", async () => {
    const session = await liveSession();
    const { access_token } = await sign({ nodes: [nodes[1], nodes[2]], session });
    expect(verifyToken(access_token)).toBe(true);
  });

  it("takes sub, aud, scope and cnf.jkt from the assertion, not from extra fields on the request", async () => {
    const session = await liveSession();
    const attempt = await prepare({ nodes, session });
    const tampered = {
      ...attempt.request,
      sub: "admin",
      aud: "another_client",
      scope: "admin",
      cnfJkt: newDPoPKeyPair().cnfJkt,
    };

    const responses = await Promise.all(nodes.map((n) => postSign(n, { ...signBody(attempt), request: tampered })));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);

    // Every node signed the assertion's own claims, so the client rebuilds and verifies
    // the payload the assertion actually carries, ignoring the extra fields above.
    const atParts = createSigningInput({ header: { alg: "EdDSA", typ: "at+jwt", kid: DEFAULT_KEY_ID }, payload: attempt.atPayload });
    const decodedCommitments = attempt.commitments.map((c) => ({ nodeId: c.nodeId, D: base64UrlDecode(c.D), E: base64UrlDecode(c.E) }));
    const R = computeGroupCommitment(atParts.signingInput, decodedCommitments);
    const signature = aggregateSignatureShares(
      R,
      responses.map((r) => BigInt("0x" + r.body.at))
    );
    const token = assembleJwt(atParts.headerB64, atParts.payloadB64, signature);

    expect(verifyToken(token)).toBe(true);
    const { payload } = decodeJwt(token);
    expect(payload.sub).toBe("usr_alice_12345");
    expect(payload.aud).toBe(CLIENT_ID);
    expect(payload.scope).toBe(SCOPE);
    expect(payload.cnf).toEqual({ jkt: session.cnfJkt });
  });

  it("rejects another DPoP key, another htu, a stale proof, and an over-long access token lifetime", async () => {
    const session = await liveSession();

    const wrongKey = await prepare({ nodes: [nodes[0]], session, keyPairOverride: newDPoPKeyPair().keyPair });
    const wrongKeyRes = await postSign(nodes[0], signBody(wrongKey));
    expect(wrongKeyRes.status).toBe(400);
    expect(wrongKeyRes.body.error).toContain("thumbprint mismatch");

    const wrongHtu = await prepare({ nodes: [nodes[0]], session, proofHtuOverride: "http://evil.test/token" });
    const wrongHtuRes = await postSign(nodes[0], signBody(wrongHtu));
    expect(wrongHtuRes.status).toBe(400);
    expect(wrongHtuRes.body.error).toContain("htu mismatch");

    const stale = await prepare({ nodes: [nodes[0]], session, dpopIatOverride: clock.nowSeconds() - 120 });
    const staleRes = await postSign(nodes[0], signBody(stale));
    expect(staleRes.status).toBe(400);
    expect(staleRes.body.error).toContain("timestamp expired or out of allowed window");

    const tooLong = await prepare({ nodes: [nodes[0]], session, lifetimeSeconds: 3601 });
    const tooLongRes = await postSign(nodes[0], signBody(tooLong));
    expect(tooLongRes.status).toBe(400);
    expect(tooLongRes.body.error).toContain("Access token lifetime 3601s out of range");
  });

  it("does not track jti: the same DPoP proof twice both succeed, each bound to the caller's own key", async () => {
    const session = await liveSession();
    const attempt = await prepare({ nodes, session });
    const first = await postSign(nodes[0], signBody(attempt));
    expect(first.status).toBe(200);

    // A fresh round with the exact same DPoP proof reused.
    const again = await prepare({ nodes: [nodes[0]], session, dpopProofOverride: attempt.request.dpopProof as string });
    const againRes = await postSign(nodes[0], signBody(again));
    expect(againRes.status).toBe(200);
  });

  it("refuses an assertion older than the 30-second window, per the node's own clock", async () => {
    const session = await liveSession({ nonce: "c-stale" });
    clock.advance(31);
    try {
      const attempt = await prepare({ nodes: [nodes[0]], session });
      const res = await postSign(nodes[0], signBody(attempt));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("rejected assertion");
    } finally {
      clock.advance(-31);
    }
  });
});

describe("refresh grant over HTTP", () => {
  it("spends the refresh token with a fresh DPoP proof, and rotates it", async () => {
    const session = await liveSession();
    const first = await sign({ nodes, session });
    expect(decodeJwt(first.refresh_token).header.typ).toBe("refresh+jwt");

    const second = await sign({
      nodes,
      session,
      grant: "refresh_token",
      refreshToken: first.refresh_token,
      lifetimeSeconds: 900,
    });
    expect(verifyToken(second.access_token)).toBe(true);
    expect(verifyToken(second.refresh_token)).toBe(true);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(decodeJwt(second.access_token).payload).toMatchObject({
      sub: "usr_alice_12345",
      aud: CLIENT_ID,
      scope: SCOPE,
      cnf: { jkt: session.cnfJkt },
    });
    expect(decodeJwt(second.access_token).payload.exp - decodeJwt(second.access_token).payload.iat).toBe(900);

    // The old refresh token still spends: the node keeps no revocation state.
    const third = await sign({ nodes, session, grant: "refresh_token", refreshToken: first.refresh_token, lifetimeSeconds: 900 });
    expect(verifyToken(third.access_token)).toBe(true);
  });

  it("refuses a proof from another key: it does not match the refresh token's cnf.jkt", async () => {
    const session = await liveSession();
    const first = await sign({ nodes, session });

    const foreign = await prepare({
      nodes,
      session,
      grant: "refresh_token",
      refreshToken: first.refresh_token,
      keyPairOverride: newDPoPKeyPair().keyPair,
    });
    const res = await postSign(nodes[0], signBody(foreign));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("thumbprint mismatch");
  });

  it("refuses a tampered refresh token and an access token presented as one", async () => {
    const session = await liveSession();
    const { access_token, refresh_token } = await sign({ nodes, session });

    const [h, p, sig] = refresh_token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.scope = "admin";
    const forged = `${h}.${base64UrlEncode(JSON.stringify(payload))}.${sig}`;

    for (const [token, reason] of [
      [forged, "Invalid Ed25519 signature"],
      [access_token, "typ at+jwt is not refresh+jwt"],
    ] as const) {
      const attempt = await prepare({ nodes, session, grant: "refresh_token", refreshToken: token });
      const res = await postSign(nodes[0], signBody(attempt));
      expect(res.status, reason).toBe(400);
      expect(res.body.error).toContain(reason);
    }
  });
});

describe("concurrent rounds", () => {
  it("keeps two interleaved rounds apart", async () => {
    const [sessionA, sessionB] = await Promise.all([
      liveSession({ nonce: "c-round-a" }),
      liveSession({ username: "bob", password: "password456", nonce: "c-round-b" }),
    ]);
    expect(verifyToken(sessionA.assertion)).toBe(true);
    expect(verifyToken(sessionB.assertion)).toBe(true);
    expect(decodeJwt(sessionA.assertion).payload.sub).toBe("usr_alice_12345");
    expect(decodeJwt(sessionB.assertion).payload.sub).toBe("usr_bob_67890");
  });

  it("issues access tokens for two concurrent assertions", async () => {
    const [first, second] = await Promise.all([liveSession(), liveSession({ username: "bob", password: "password456" })]);
    const tokens = await Promise.all([sign({ nodes, session: first }), sign({ nodes, session: second })]);
    expect(verifyToken(tokens[0].access_token)).toBe(true);
    expect(verifyToken(tokens[1].access_token)).toBe(true);
    expect(decodeJwt(tokens[0].access_token).payload.sub).toBe("usr_alice_12345");
    expect(decodeJwt(tokens[1].access_token).payload.sub).toBe("usr_bob_67890");
  });
});

describe("payment for /sign", () => {
  let node: FixtureNode;

  /** node-1 on alice's users file, with no credit, unless told otherwise. */
  async function startPaidNode(options: StartNodeOptions = {}): Promise<FixtureNode> {
    node = await startNodeFromFixture("node-1.json", { clock, usersFile: nodes[0].usersFile, ...options });
    return node;
  }

  afterEach(async () => {
    await node?.close();
  });

  const credit = () => node.node.billing.credits.balance(GATEWAY_ID);
  const signOn = async () => signBody(await prepare({ nodes: [node], session: await liveSession() }));
  const send = (body: Record<string, unknown>, headers: Record<string, string> = {}) => postJson(node.url, "/sign", body, { headers });

  /** A first /sign answered 402, then paid for. */
  async function pay(body: Record<string, unknown>) {
    const refused = await send(body);
    expect(refused.status).toBe(402);
    return send(body, { "PAYMENT-SIGNATURE": paymentSignature(refused) });
  }

  it("asks a gateway without credit for 2 requests' worth, to the node's wallet", async () => {
    await startPaidNode();
    const res = await send(withAssertion(node, await signOn()));

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("payment required");
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      amount: "6000",
      payTo: readFixtureJson("node-1.json").wallet.address,
    });
  });

  it("serves the paid retry on the same rounds, returns the settlement, and leaves one credit", async () => {
    await startPaidNode();
    const res = await pay(withAssertion(node, await signOn()));

    expect(res.status).toBe(200);
    expect(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!)).toMatchObject({ success: true, transaction: "0x" + "ab".repeat(32) });
    expect(credit()).toBe(1);
  });

  it("serves the next /sign on credit, then asks again", async () => {
    await startPaidNode();
    expect((await pay(withAssertion(node, await signOn()))).status).toBe(200);

    const onCredit = await send(withAssertion(node, await signOn()));
    expect(onCredit.status).toBe(200);
    expect(onCredit.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(credit()).toBe(0);

    expect((await send(withAssertion(node, await signOn()))).status).toBe(402);
  });

  it("refuses a caller that is not a registered gateway with 400, before credit or rounds are looked at", async () => {
    await startPaidNode();
    const body = await signOn();
    const otherKey = ed25519.utils.randomPrivateKey();
    const forgeries = [
      "not-a-jwt",
      clientAssertion(node, {}, otherKey),
      clientAssertion(node, { aud: "http://node2.test" }),
      clientAssertion(node, { iss: "mallory", sub: "mallory" }),
      clientAssertion(node, { exp: clock.nowSeconds() }),
    ];

    for (const forged of forgeries) {
      const res = await send(withAssertion(node, body, forged));
      expect(res.status, forged).toBe(400);
      expect(res.body.error).toMatch(/^client_assertion: /);
    }
    const missing = await send(body);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("body.request.clientAssertion");

    // Credit is still untouched and the rounds still open: the real gateway pays and is served.
    expect(credit()).toBe(0);
    expect((await pay(withAssertion(node, body))).status).toBe(200);

    // With credit, a forged caller is still refused and spends nothing.
    const again = await send(withAssertion(node, await signOn(), clientAssertion(node, {}, otherKey)));
    expect(again.status).toBe(400);
    expect(credit()).toBe(1);
  });

  it("charges nothing for a /sign the node refuses", async () => {
    await startPaidNode();
    const session = await liveSession();
    const [h, p, sig] = session.assertion.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.sub = "usr_bob_67890";
    const forged = `${h}.${base64UrlEncode(JSON.stringify(payload))}.${sig}`;
    const tampered = () => prepare({ nodes: [node], session, assertionOverride: forged }).then((a) => withAssertion(node, signBody(a)));

    const paid = await pay(await tampered());
    expect(paid.status).toBe(400);
    expect(paid.body.error).toContain("Invalid Ed25519 signature");
    expect(paid.headers.get("PAYMENT-RESPONSE")).not.toBeNull();
    expect(credit()).toBe(2);

    expect((await send(await tampered())).status).toBe(400);
    expect(credit()).toBe(2);
  });

  it("stays at 402 when the payment does not settle", async () => {
    await startPaidNode({ settler: failingSettler });
    const res = await pay(withAssertion(node, await signOn()));

    expect(res.status).toBe(402);
    expect(res.body.error).toContain("settlement failed");
    expect(res.body.error).toContain("insufficient_funds");
    expect(credit()).toBe(0);
  });

  it("stays at 402 for a payment of the wrong amount or a malformed header", async () => {
    await startPaidNode();
    const body = withAssertion(node, await signOn());
    const refused = await send(body);
    const required = decodePaymentRequiredHeader(refused.headers.get("PAYMENT-REQUIRED")!);
    const cheap = encodePaymentSignatureHeader({ x402Version: 2, accepted: { ...required.accepts[0], amount: "1" }, payload: {} });

    for (const [header, reason] of [
      [cheap, "payment does not match the requirements"],
      ["%%%", "PAYMENT-SIGNATURE"],
    ]) {
      const res = await send(body, { "PAYMENT-SIGNATURE": header });
      expect(res.status, reason).toBe(402);
      expect(res.body.error).toContain(reason);
    }
    expect(credit()).toBe(0);
  });

  it("keeps the credit across a restart on the same credits file", async () => {
    const first = await startPaidNode();
    expect((await pay(withAssertion(node, await signOn()))).status).toBe(200);
    await first.close();

    await startPaidNode({ creditsFile: first.creditsFile });
    expect(credit()).toBe(1);
    expect((await send(withAssertion(node, await signOn()))).status).toBe(200);
    expect(credit()).toBe(0);
  });
});
