import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDemoLog, shortValue } from "../src/http/demo-log.js";
import { commitEndpoint } from "../src/http/endpoint/commit.js";
import { health } from "../src/http/endpoint/health.js";
import { signEndpoint } from "../src/http/endpoint/sign.js";
import { signOnEndpoint } from "../src/http/endpoint/sign-on.js";
import { problemOf } from "../src/http/validate.js";
import { FakeClock, TEST_ISSUER, buildNodeFromFixture } from "./helpers/build-node.js";
import { ClientSession, decodeJwt, signOnOverHttp, signOverHttp } from "./helpers/client.js";
import { RunningNode, startAllNodes, stopAll } from "./helpers/http-server.js";
import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { createDPoPProof } from "@decentralized-idp/sdk/dpop";
import { commitRequest, signOnRequest, signRequest } from "@decentralized-idp/sdk/node-api";
import { blind } from "@decentralized-idp/sdk/toprf";

/**
 * Each `...Endpoint` function takes a body the sdk's schema has decoded, runs the use case,
 * encodes the response and writes its demo-log lines. The "decode errors" suites run the
 * schemas through `problemOf`, the text `badRequest` puts in the 400 body. The `/sign` suites
 * need a credential that verifies under the group key, so one assertion and one refresh token
 * are minted once over HTTP against all three fixture nodes.
 */

const PASSWORD = "password123";
const CLIENT_ID = "demo_client";
const SCOPE = "openid profile";
const ALICE_SUB = "usr_alice_12345";
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

function disabledDemo(nodeId: number) {
  return createDemoLog({ nodeId, env: { DEMO_LOG: "0" } });
}

/** A plain-text (no colour) demo log that records every line it is given. */
function capturingDemo(nodeId: number): { demo: ReturnType<typeof createDemoLog>; lines: string[] } {
  const lines: string[] = [];
  return { demo: createDemoLog({ nodeId, env: {}, isTty: false, write: (line) => lines.push(line) }), lines };
}

const clock = new FakeClock(1_700_000_000);
let realAssertion: string;
let realRefreshToken: string;
let realSession: ClientSession;

beforeAll(async () => {
  const nodes: RunningNode[] = await startAllNodes({ clock });
  try {
    realSession = await signOnOverHttp({
      nodes,
      username: "alice",
      password: PASSWORD,
      clientId: CLIENT_ID,
      issuer: TEST_ISSUER,
      scope: SCOPE,
      nonce: "setup-nonce",
      now: clock.nowSeconds(),
    });
    const tokens = await signOverHttp({ nodes, session: realSession, now: clock.nowSeconds() });
    realAssertion = realSession.assertion;
    realRefreshToken = tokens.refresh_token;
  } finally {
    await stopAll(nodes);
  }
});

describe("/health", () => {
  it("reports this node's id and its base64url group public key", () => {
    const { node } = buildNodeFromFixture("node-1.json", { clock });
    expect(health(node)).toEqual({
      status: "ok",
      nodeId: 1,
      groupPublicKey: base64UrlEncode(node.identity.groupPublicKey),
    });
  });
});

describe("/commit", () => {
  it("rejects a missing or empty roundId, and a non-object body", () => {
    expect(problemOf(commitRequest.safeParse({}).error!)).toBe("body.roundId is required");
    expect(problemOf(commitRequest.safeParse({ roundId: "" }).error!)).toBe("body.roundId must not be empty");
    expect(problemOf(commitRequest.safeParse("nope").error!)).toBe("body Invalid input: expected object, received string");
    expect(problemOf(commitRequest.safeParse(null).error!)).toBe("body Invalid input: expected object, received null");
  });

  it("answers a base64url commitment and logs one demo line", () => {
    const { node } = buildNodeFromFixture("node-1.json", { clock });
    const { demo, lines } = capturingDemo(1);
    const roundId = crypto.randomUUID();

    const res = commitEndpoint(node, { roundId }, demo);

    expect(res.nodeId).toBe(1);
    expect(res.D).toMatch(BASE64URL_32);
    expect(res.E).toMatch(BASE64URL_32);
    expect(lines).toEqual([`[node1]   commit    round=${shortValue(roundId)}  → D_1,E_1 ${shortValue(res.D)} ${shortValue(res.E)}`]);
  });
});

/** A well-formed `/sign-on` request body, for tests that break exactly one field. */
function validSignOnRequest(): Record<string, unknown> {
  return {
    username: "alice",
    blinded: base64UrlEncode(crypto.randomBytes(32)),
    sessionNonce: base64UrlEncode(crypto.randomBytes(16)),
    cnfJkt: "jkt-value",
    clientId: CLIENT_ID,
    scope: SCOPE,
    nonce: "challenge-1",
    iat: 1_700_000_000,
    exp: 1_700_000_020,
    commitments: [{ nodeId: 1, D: base64UrlEncode(crypto.randomBytes(32)), E: base64UrlEncode(crypto.randomBytes(32)) }],
    allParticipants: [1],
  };
}

describe("/sign-on: decode errors", () => {
  it("rejects a missing or empty roundId", () => {
    expect(problemOf(signOnRequest.safeParse({ request: validSignOnRequest() }).error!)).toBe("body.roundId is required");
    expect(problemOf(signOnRequest.safeParse({ roundId: "", request: validSignOnRequest() }).error!)).toBe("body.roundId must not be empty");
  });

  it("rejects a non-object body or request", () => {
    expect(problemOf(signOnRequest.safeParse("nope").error!)).toBe("body Invalid input: expected object, received string");
    expect(problemOf(signOnRequest.safeParse({ roundId: "r1", request: "nope" }).error!)).toBe(
      "body.request Invalid input: expected object, received string"
    );
  });

  const cases: Array<[string, Partial<Record<string, unknown>>, string]> = [
    ["username missing", { username: undefined }, "body.request.username is required"],
    ["username empty", { username: "" }, "body.request.username must not be empty"],
    ["blinded missing", { blinded: undefined }, "body.request.blinded is required"],
    ["blinded wrong length", { blinded: base64UrlEncode(crypto.randomBytes(31)) }, "body.request.blinded must decode to 32 bytes, got 31"],
    ["blinded padded", { blinded: base64UrlEncode(crypto.randomBytes(32)) + "==" }, "body.request.blinded must be base64url without padding"],
    ["sessionNonce missing", { sessionNonce: undefined }, "body.request.sessionNonce is required"],
    ["sessionNonce not base64url", { sessionNonce: "not base64url!" }, "body.request.sessionNonce must be base64url without padding"],
    ["cnfJkt missing", { cnfJkt: undefined }, "body.request.cnfJkt is required"],
    ["cnfJkt empty", { cnfJkt: "" }, "body.request.cnfJkt must not be empty"],
    ["clientId missing", { clientId: undefined }, "body.request.clientId is required"],
    ["clientId empty", { clientId: "" }, "body.request.clientId must not be empty"],
    ["scope not a string", { scope: 1 }, "body.request.scope must be a string"],
    ["iat missing", { iat: undefined }, "body.request.iat must be an integer"],
    ["iat not an integer", { iat: 1.5 }, "body.request.iat must be an integer"],
    ["exp missing", { exp: undefined }, "body.request.exp must be an integer"],
    ["exp not an integer", { exp: "soon" }, "body.request.exp must be an integer"],
    ["commitments missing", { commitments: undefined }, "body.request.commitments must be an array"],
    [
      "commitments entry wrong D length",
      { commitments: [{ nodeId: 1, D: "AAAA", E: "AAAA" }] },
      "body.request.commitments.0.D must decode to 32 bytes, got 3",
    ],
    [
      "commitments entry padded",
      { commitments: [{ nodeId: 1, D: base64UrlEncode(crypto.randomBytes(32)) + "==", E: base64UrlEncode(crypto.randomBytes(32)) }] },
      "body.request.commitments.0.D must be base64url without padding",
    ],
    [
      "commitments entry nodeId not numeric",
      { commitments: [{ nodeId: "1", D: "x", E: "y" }] },
      "body.request.commitments.0.nodeId must be an integer",
    ],
    ["allParticipants missing", { allParticipants: undefined }, "body.request.allParticipants must be an array"],
    ["allParticipants not an array", { allParticipants: "1,2" }, "body.request.allParticipants must be an array"],
    ["nonce is a literal null", { nonce: null }, "body.request.nonce must be a string"],
  ];

  it.each(cases)("rejects %s", (_name, patch, expected) => {
    const result = signOnRequest.safeParse({ roundId: "r1", request: { ...validSignOnRequest(), ...patch } });
    expect(problemOf(result.error!)).toBe(expected);
  });
});

describe("/sign-on: success", () => {
  it("decodes the request field for field, encodes the response, and logs both demo lines", () => {
    const { node } = buildNodeFromFixture("node-1.json", { clock });
    const { demo, lines } = capturingDemo(1);
    const roundId = crypto.randomUUID();
    const own = commitEndpoint(node, { roundId }, disabledDemo(1));

    const blindedPoint = blind(PASSWORD).blinded;
    const blindedWire = base64UrlEncode(blindedPoint.toRawBytes());
    const sessionNonce = crypto.randomBytes(16);
    const sessionNonceWire = base64UrlEncode(sessionNonce);
    const now = clock.nowSeconds();

    const parsed = signOnRequest.parse({
      roundId,
      request: {
        username: "alice",
        blinded: blindedWire,
        sessionNonce: sessionNonceWire,
        cnfJkt: "jkt-value",
        clientId: CLIENT_ID,
        scope: SCOPE,
        nonce: "challenge-1",
        iat: now,
        exp: now + 20,
        commitments: [{ nodeId: own.nodeId, D: own.D, E: own.E }],
        allParticipants: [own.nodeId],
      },
    });

    const res = signOnEndpoint(node, parsed, demo);

    expect(res.nodeId).toBe(1);
    expect(res.sub).toBe(ALICE_SUB);
    expect(res.toprfPartial).toMatch(BASE64URL_32);
    expect(res.ct_i).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(res.ct_i.length).toBeGreaterThan(res.toprfPartial.length);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `[node1]   sign-on   round=${shortValue(roundId)} user=alice  ` +
        `← A ${shortValue(blindedWire)}  (D,E)×1  ` +
        `nonce_s ${shortValue(sessionNonceWire)}  jkt ${shortValue("jkt-value")}`
    );
    expect(lines[1]).toBe(`${" ".repeat(20)}→ B_1=k_1·A ${shortValue(res.toprfPartial)}  ct_1=AEAD_h1(z_1) ${shortValue(res.ct_i)}`);
  });

  it("accepts an empty scope", () => {
    const { node } = buildNodeFromFixture("node-1.json", { clock });
    const demo = disabledDemo(1);
    const roundId = crypto.randomUUID();
    const own = commitEndpoint(node, { roundId }, demo);
    const now = clock.nowSeconds();

    const parsed = signOnRequest.parse({
      roundId,
      request: {
        username: "alice",
        blinded: base64UrlEncode(blind(PASSWORD).blinded.toRawBytes()),
        sessionNonce: base64UrlEncode(crypto.randomBytes(16)),
        cnfJkt: "jkt-value",
        clientId: CLIENT_ID,
        scope: "",
        iat: now,
        exp: now + 20,
        commitments: [{ nodeId: own.nodeId, D: own.D, E: own.E }],
        allParticipants: [own.nodeId],
      },
    });

    expect(() => signOnEndpoint(node, parsed, demo)).not.toThrow();
  });

  it("leaves an omitted nonce out of the signed payload entirely, distinct from an explicit empty one", () => {
    const { node } = buildNodeFromFixture("node-1.json", { clock });
    const demo = disabledDemo(1);
    const now = clock.nowSeconds();
    const sessionNonce = crypto.randomBytes(16);

    const baseRequest = {
      username: "alice",
      blinded: base64UrlEncode(blind(PASSWORD).blinded.toRawBytes()),
      sessionNonce: base64UrlEncode(sessionNonce),
      cnfJkt: "jkt-value",
      clientId: CLIENT_ID,
      scope: SCOPE,
      iat: now,
      exp: now + 20,
      allParticipants: [1],
    };

    // Two independent rounds, so each request gets its own nonce pair.
    const roundOmitted = crypto.randomUUID();
    const roundEmpty = crypto.randomUUID();
    const ownOmitted = commitEndpoint(node, { roundId: roundOmitted }, demo);
    const ownEmpty = commitEndpoint(node, { roundId: roundEmpty }, demo);

    const parsedOmitted = signOnRequest.parse({
      roundId: roundOmitted,
      request: { ...baseRequest, commitments: [{ nodeId: ownOmitted.nodeId, D: ownOmitted.D, E: ownOmitted.E }] },
    });
    const parsedEmptyNonce = signOnRequest.parse({
      roundId: roundEmpty,
      request: { ...baseRequest, nonce: "", commitments: [{ nodeId: ownEmpty.nodeId, D: ownEmpty.D, E: ownEmpty.E }] },
    });

    const resOmitted = signOnEndpoint(node, parsedOmitted, demo);
    const resEmptyNonce = signOnEndpoint(node, parsedEmptyNonce, demo);

    // A literal null is refused outright by the schema, distinct from both of the above.
    const nullResult = signOnRequest.safeParse({
      roundId: crypto.randomUUID(),
      request: { ...baseRequest, nonce: null, commitments: [] },
    });
    expect(problemOf(nullResult.error!)).toBe("body.request.nonce must be a string");

    // Neither is refused, and they sign different payloads, so the ciphertexts differ.
    expect(resOmitted.ct_i).not.toBe(resEmptyNonce.ct_i);
  });
});

/** A well-formed `/sign` request body for the `authorization_code` grant. */
function validSignRequest(): Record<string, unknown> {
  return {
    grant: "authorization_code",
    assertion: realAssertion,
    dpopProof: "placeholder",
    claims: { iat: 1_700_000_000, exp: 1_700_003_600, jti: "token-id-1" },
    commitments: [{ nodeId: 1, D: base64UrlEncode(crypto.randomBytes(32)), E: base64UrlEncode(crypto.randomBytes(32)) }],
    refreshCommitments: [{ nodeId: 1, D: base64UrlEncode(crypto.randomBytes(32)), E: base64UrlEncode(crypto.randomBytes(32)) }],
    allParticipants: [1],
  };
}

describe("/sign: decode errors", () => {
  it("rejects a missing or empty roundId / refreshRoundId", () => {
    expect(problemOf(signRequest.safeParse({ refreshRoundId: "r3", request: validSignRequest() }).error!)).toBe("body.roundId is required");
    expect(problemOf(signRequest.safeParse({ roundId: "r2", request: validSignRequest() }).error!)).toBe("body.refreshRoundId is required");
    expect(problemOf(signRequest.safeParse({ roundId: "", refreshRoundId: "r3", request: validSignRequest() }).error!)).toBe(
      "body.roundId must not be empty"
    );
  });

  it("requires the two rounds to differ", () => {
    const { node } = buildNodeFromFixture("node-1.json", { clock });
    const demo = disabledDemo(1);
    const parsed = signRequest.parse({ roundId: "same", refreshRoundId: "same", request: validSignRequest() });
    expect(() => signEndpoint(node, parsed, demo)).toThrowError(/needs two different rounds/);
  });

  it("rejects a non-object body or request", () => {
    expect(problemOf(signRequest.safeParse("nope").error!)).toBe("body Invalid input: expected object, received string");
    expect(problemOf(signRequest.safeParse({ roundId: "r2", refreshRoundId: "r3", request: "nope" }).error!)).toBe(
      "body.request Invalid input: expected object, received string"
    );
  });

  it("rejects an unknown grant value, and a missing grant, the same way", () => {
    expect(
      problemOf(signRequest.safeParse({ roundId: "r2", refreshRoundId: "r3", request: { ...validSignRequest(), grant: "password" } }).error!)
    ).toBe('body.request.grant must be "authorization_code" or "refresh_token"');
    expect(
      problemOf(signRequest.safeParse({ roundId: "r2", refreshRoundId: "r3", request: { ...validSignRequest(), grant: undefined } }).error!)
    ).toBe('body.request.grant must be "authorization_code" or "refresh_token"');
  });

  it("rejects a missing credential for the grant named", () => {
    const { assertion: _drop, ...noAssertion } = validSignRequest();
    expect(problemOf(signRequest.safeParse({ roundId: "r2", refreshRoundId: "r3", request: noAssertion }).error!)).toBe(
      "body.request assertion (authorization_code) or refreshToken (refresh_token) must not be empty"
    );

    expect(
      problemOf(
        signRequest.safeParse({ roundId: "r2", refreshRoundId: "r3", request: { ...validSignRequest(), grant: "refresh_token" } }).error!
      )
    ).toBe("body.request assertion (authorization_code) or refreshToken (refresh_token) must not be empty");
  });

  const cases: Array<[string, Partial<Record<string, unknown>>, string]> = [
    ["dpopProof missing", { dpopProof: undefined }, "body.request.dpopProof is required"],
    ["claims missing", { claims: undefined }, "body.request.claims Invalid input: expected object, received undefined"],
    ["claims.iat not an integer", { claims: { iat: 1.5, exp: 1_700_003_600, jti: "j" } }, "body.request.claims.iat must be an integer"],
    ["claims.exp not an integer", { claims: { iat: 1, exp: "later", jti: "j" } }, "body.request.claims.exp must be an integer"],
    ["claims.jti empty", { claims: { iat: 1, exp: 2, jti: "" } }, "body.request.claims.jti must not be empty"],
    ["commitments missing", { commitments: undefined }, "body.request.commitments must be an array"],
    ["refreshCommitments missing", { refreshCommitments: undefined }, "body.request.refreshCommitments must be an array"],
    ["allParticipants missing", { allParticipants: undefined }, "body.request.allParticipants must be an array"],
  ];

  it.each(cases)("rejects %s", (_name, patch, expected) => {
    const result = signRequest.safeParse({ roundId: "r2", refreshRoundId: "r3", request: { ...validSignRequest(), ...patch } });
    expect(problemOf(result.error!)).toBe(expected);
  });
});

describe("/sign: success", () => {
  it("reads only the assertion for an authorization_code grant, ignoring an unparsable refreshToken", () => {
    const { node } = buildNodeFromFixture("node-1.json", { clock });
    const { demo, lines } = capturingDemo(1);
    const accessRoundId = crypto.randomUUID();
    const refreshRoundId = crypto.randomUUID();
    const commit1 = commitEndpoint(node, { roundId: accessRoundId }, disabledDemo(1));
    const commit2 = commitEndpoint(node, { roundId: refreshRoundId }, disabledDemo(1));
    const now = clock.nowSeconds();
    const dpopProof = createDPoPProof(realSession.dpopKeyPair, "POST", `${realSession.issuer}/token`, now);
    const claims = { iat: now, exp: now + 3600, jti: crypto.randomUUID() };

    const parsed = signRequest.parse({
      roundId: accessRoundId,
      refreshRoundId,
      request: {
        grant: "authorization_code",
        assertion: realAssertion,
        refreshToken: "not-a-jwt-garbage",
        dpopProof,
        claims,
        commitments: [{ nodeId: commit1.nodeId, D: commit1.D, E: commit1.E }],
        refreshCommitments: [{ nodeId: commit2.nodeId, D: commit2.D, E: commit2.E }],
        allParticipants: [commit1.nodeId],
      },
    });

    const res = signEndpoint(node, parsed, demo);

    expect(res.nodeId).toBe(1);
    expect(res.at).toMatch(HEX_64);
    expect(res.rt).toMatch(HEX_64);

    const signature = realAssertion.split(".")[2] ?? "";
    const dpopJti = (decodeJwt(dpopProof).payload as { jti: string }).jti;
    expect(lines).toEqual([
      `[node1]   sign      round=${shortValue(accessRoundId)} grant=authz  ← assertion σ ${shortValue(signature)} ✓  ` +
        `DPoP ✓ jti ${shortValue(dpopJti)}  (D,E)×1  → at z_1 ${shortValue(res.at)} + rt(refresh+jwt) z_1 ${shortValue(res.rt)}`,
    ]);
    // Only the 8-character prefix of z_i reaches the log.
    expect(lines.join("\n")).not.toContain(res.at.slice(8));
    expect(lines.join("\n")).not.toContain(res.rt.slice(8));
  });

  it("reads only the refreshToken for a refresh_token grant, ignoring an unparsable assertion", () => {
    const { node } = buildNodeFromFixture("node-1.json", { clock });
    const { demo, lines } = capturingDemo(1);
    const accessRoundId = crypto.randomUUID();
    const refreshRoundId = crypto.randomUUID();
    const commit1 = commitEndpoint(node, { roundId: accessRoundId }, disabledDemo(1));
    const commit2 = commitEndpoint(node, { roundId: refreshRoundId }, disabledDemo(1));
    const now = clock.nowSeconds();
    const dpopProof = createDPoPProof(realSession.dpopKeyPair, "POST", `${realSession.issuer}/token`, now);
    const claims = { iat: now, exp: now + 3600, jti: crypto.randomUUID() };

    const parsed = signRequest.parse({
      roundId: accessRoundId,
      refreshRoundId,
      request: {
        grant: "refresh_token",
        assertion: "not-a-jwt-garbage",
        refreshToken: realRefreshToken,
        dpopProof,
        claims,
        commitments: [{ nodeId: commit1.nodeId, D: commit1.D, E: commit1.E }],
        refreshCommitments: [{ nodeId: commit2.nodeId, D: commit2.D, E: commit2.E }],
        allParticipants: [commit1.nodeId],
      },
    });

    const res = signEndpoint(node, parsed, demo);

    expect(res.at).toMatch(HEX_64);
    expect(res.rt).toMatch(HEX_64);

    const signature = realRefreshToken.split(".")[2] ?? "";
    const dpopJti = (decodeJwt(dpopProof).payload as { jti: string }).jti;
    expect(lines).toEqual([
      `[node1]   sign      round=${shortValue(accessRoundId)} grant=refresh  ← refresh_token σ ${shortValue(signature)} ✓ (typ=refresh+jwt)  ` +
        `DPoP ✓ jti ${shortValue(dpopJti)}  (D,E)×1  → at z_1 ${shortValue(res.at)} + rt z_1 ${shortValue(res.rt)}`,
    ]);
  });
});
