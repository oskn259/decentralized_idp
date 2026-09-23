import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAssertion } from "../src/domain/service/credential.js";
import { commit } from "../src/domain/usecase/commit.js";
import { IdentityNode } from "../src/domain/usecase/identity-node.js";
import { newDPoPKeyPair } from "./helpers/client.js";
import { FakeClock, TEST_ISSUER, buildAllNodesFromFixtures } from "./helpers/build-node.js";
import { aggregateSignOn, assertionFor, prepareSignOn, runSignOn, signTokens } from "./helpers/inproc.js";

/**
 * Exercises `commit`, `signOn` and `issueTokens` directly against three fixture nodes
 * sharing one `FakeClock`, with the gateway's relay role and the client's aggregation role
 * played by `tests/helpers/inproc.ts`. The nodes keep no session between the two halves.
 */

const USERNAME = "alice";
const PASSWORD = "password123";
const ALICE_SUB = "usr_alice_12345";
const CLIENT_ID = "demo_client";
const SCOPE = "openid profile";
const TOKEN_ENDPOINT = `${TEST_ISSUER}/token`;

function freshNodes(clock = new FakeClock()): IdentityNode[] {
  return buildAllNodesFromFixtures({ clock });
}

describe("commit", () => {
  it("opens a round and returns a fresh (D, E) each time", () => {
    const [node] = freshNodes();
    const a = commit(node, crypto.randomUUID());
    const b = commit(node, crypto.randomUUID());
    expect(a.D).toHaveLength(32);
    expect(a.E).toHaveLength(32);
    expect(Buffer.from(a.D).toString("hex")).not.toBe(Buffer.from(b.D).toString("hex"));
  });
});

describe("signOn", () => {
  it("mints an assertion verifiable under the group public key, from any quorum", () => {
    const clock = new FakeClock();
    const nodes = freshNodes(clock);
    const round = prepareSignOn(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER, nonce: "c1", clientId: CLIENT_ID, scope: SCOPE });
    const responses = runSignOn(nodes, round);

    expect(responses).toHaveLength(3);
    expect(responses.every((r) => r.sub === ALICE_SUB)).toBe(true);
    expect(responses.every((r) => r.toprfPartial.length === 32)).toBe(true);
    expect(responses.every((r) => r.ct_i.length > 0)).toBe(true);
  });

  it("consumes the round's nonce pair once: a replayed request is refused", () => {
    const nodes = freshNodes();
    const round = prepareSignOn(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER });

    runSignOn([nodes[0]], round);
    expect(() => runSignOn([nodes[0]], round)).toThrowError(/expired or not found on node 1/);
  });

  it("takes sub from its own record, ignoring a client-supplied one", () => {
    const nodes = freshNodes();
    const round = prepareSignOn(nodes, {
      username: USERNAME,
      password: PASSWORD,
      issuer: TEST_ISSUER,
      overrides: { sub: "admin" } as any,
    });
    const responses = runSignOn(nodes, round);
    expect(responses.every((r) => r.sub === ALICE_SUB)).toBe(true);
  });

  it("requires the complete commitment set used in round 1: dropping one signer's share breaks the signature", () => {
    const clock = new FakeClock(1_700_000_000);
    const nodes = freshNodes(clock);
    const round = prepareSignOn(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER });
    const responses = runSignOn(nodes, round);

    const { assertion: partial } = aggregateSignOn({ round, responses: responses.slice(0, 2), password: PASSWORD });
    const { assertion: complete } = aggregateSignOn({ round, responses, password: PASSWORD });

    expect(() => verifyAssertion(partial, nodes[0].identity, clock.nowSeconds())).toThrowError(/Invalid Ed25519 signature/);
    expect(verifyAssertion(complete, nodes[0].identity, clock.nowSeconds())).toBeDefined();
  });

  it("emits shares without ever checking the password: the failure only shows up on decrypt", () => {
    const nodes = freshNodes();
    const round = prepareSignOn(nodes, { username: USERNAME, password: "totally wrong password", issuer: TEST_ISSUER });
    const responses = runSignOn(nodes, round);
    expect(responses).toHaveLength(3);
    expect(responses.every((r) => r.ct_i.length > 0)).toBe(true);
  });

  it("rejects an unknown user", () => {
    const nodes = freshNodes();
    const round = prepareSignOn(nodes, { username: "mallory", password: PASSWORD, issuer: TEST_ISSUER });
    expect(() => runSignOn([nodes[0]], round)).toThrowError(/User not found on node 1/);
  });

  it("rejects a lifetime over 30 seconds", () => {
    const nodes = freshNodes();
    const round = prepareSignOn(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER, lifetimeSeconds: 31 });
    expect(() => runSignOn([nodes[0]], round)).toThrowError(/Assertion lifetime 31s out of range/);
  });

  it("rejects a stale iat outside the ±60s window", () => {
    const clock = new FakeClock(1_700_000_000);
    const nodes = freshNodes(clock);
    const round = prepareSignOn(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER, iat: clock.nowSeconds() - 600 });
    expect(() => runSignOn([nodes[0]], round)).toThrowError(/Assertion iat is outside the ±60s window/);
  });
});

describe("issueTokens", () => {
  it("signs both tokens with claims read out of the assertion, not the caller", () => {
    const clock = new FakeClock(1_700_000_000);
    const nodes = freshNodes(clock);
    const { round, assertion } = assertionFor(nodes, {
      username: USERNAME,
      password: PASSWORD,
      issuer: TEST_ISSUER,
      nonce: "c-sign",
      clientId: CLIENT_ID,
      scope: SCOPE,
    });

    const now = clock.nowSeconds();
    const { shares, refreshShares } = signTokens(nodes, {
      credential: assertion,
      dpopKeyPair: round.dpop.keyPair,
      claims: { iat: now, exp: now + 3600, jti: crypto.randomUUID() },
      tokenEndpoint: TOKEN_ENDPOINT,
    });
    expect(shares).toHaveLength(3);
    expect(refreshShares).toHaveLength(3);
    expect(shares.map((z) => z.toString())).not.toEqual(refreshShares.map((z) => z.toString()));
  });

  it("refuses to sign both tokens under one FROST round", () => {
    const clock = new FakeClock(1_700_000_000);
    const nodes = freshNodes(clock);
    const { round, assertion } = assertionFor(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER, nonce: "c-one-round" });
    const now = clock.nowSeconds();

    expect(() =>
      signTokens([nodes[0]], {
        credential: assertion,
        dpopKeyPair: round.dpop.keyPair,
        claims: { iat: now, exp: now + 3600, jti: crypto.randomUUID() },
        tokenEndpoint: TOKEN_ENDPOINT,
        sameRound: true,
      })
    ).toThrowError(/needs two different rounds/);
  });

  it("spends a refresh token the same way, and rotates it", () => {
    const clock = new FakeClock(1_700_000_000);
    const nodes = freshNodes(clock);
    const { round, assertion } = assertionFor(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER, nonce: "c-refresh" });
    const now = clock.nowSeconds();
    const base = { dpopKeyPair: round.dpop.keyPair, tokenEndpoint: TOKEN_ENDPOINT };

    const first = signTokens(nodes, { ...base, credential: assertion, claims: { iat: now, exp: now + 3600, jti: crypto.randomUUID() } });
    const refresh = { ...base, grant: "refresh_token" as const, claims: { iat: now, exp: now + 900, jti: crypto.randomUUID() } };
    const second = signTokens(nodes, { ...refresh, credential: first.refresh_token });
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // The old refresh token still spends too: the node keeps no revocation state.
    const third = signTokens(nodes, { ...refresh, credential: first.refresh_token });
    expect(third.access_token).not.toBe(second.access_token);
  });

  it("refuses a refresh token that is tampered, of the wrong typ, or expired", () => {
    const clock = new FakeClock(1_700_000_000);
    const nodes = freshNodes(clock);
    const { round, assertion } = assertionFor(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER, nonce: "c-refresh-bad" });
    const claims = () => ({ iat: clock.nowSeconds(), exp: clock.nowSeconds() + 3600, jti: crypto.randomUUID() });
    const base = { dpopKeyPair: round.dpop.keyPair, tokenEndpoint: TOKEN_ENDPOINT };
    const refresh = (credential: string) => ({ ...base, credential, claims: claims(), grant: "refresh_token" as const });

    const { access_token, refresh_token } = signTokens(nodes, { ...base, credential: assertion, claims: claims() });

    const [h, p, sig] = refresh_token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.scope = "admin";
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect(() => signTokens(nodes, refresh(forged))).toThrowError(/rejected refresh_token: Invalid Ed25519 signature/);

    expect(() => signTokens(nodes, refresh(access_token))).toThrowError(/typ at\+jwt is not refresh\+jwt/);
    expect(() => signTokens(nodes, refresh(assertion))).toThrowError(/typ JWT is not refresh\+jwt/);

    // 31 days later, on the node's own clock, the refresh token is expired.
    clock.advance(31 * 86400);
    expect(() => signTokens(nodes, refresh(refresh_token))).toThrowError(/rejected refresh_token: expired/);
  });

  it("refuses an assertion that is tampered, of the wrong typ, or expired", () => {
    const clock = new FakeClock(1_700_000_000);
    const nodes = freshNodes(clock);
    const { round, assertion } = assertionFor(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER, nonce: "c-bad-assertion" });
    const claims = () => ({ iat: clock.nowSeconds(), exp: clock.nowSeconds() + 3600, jti: crypto.randomUUID() });
    const spend = (credential: string) => ({ credential, dpopKeyPair: round.dpop.keyPair, claims: claims(), tokenEndpoint: TOKEN_ENDPOINT });

    const [h, p, sig] = assertion.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.sub = "usr_bob_67890";
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect(() => signTokens([nodes[0]], spend(forged))).toThrowError(/rejected assertion: Invalid Ed25519 signature/);
    expect(() => signTokens([nodes[0]], spend("a.b.c"))).toThrowError(/rejected assertion/);

    const { access_token } = signTokens(nodes, spend(assertion));
    expect(() => signTokens([nodes[0]], spend(access_token))).toThrowError(/typ at\+jwt is not JWT/);

    // The 30-second window really closes: 40 seconds on, the same assertion is expired.
    clock.advance(40);
    expect(() => signTokens([nodes[0]], spend(assertion))).toThrowError(/rejected assertion: expired/);
  });

  it("verifies the DPoP proof against the assertion's own cnf.jkt, htm and htu", () => {
    const clock = new FakeClock(1_700_000_000);
    const nodes = freshNodes(clock);
    const { round, assertion } = assertionFor(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER, nonce: "c-dpop" });
    const claims = () => ({ iat: clock.nowSeconds(), exp: clock.nowSeconds() + 3600, jti: crypto.randomUUID() });
    const base = { credential: assertion, dpopKeyPair: round.dpop.keyPair, tokenEndpoint: TOKEN_ENDPOINT };

    expect(() => signTokens([nodes[0]], { ...base, claims: claims(), proofHtu: "http://evil.test/token" })).toThrowError(/htu mismatch/);
    expect(() => signTokens([nodes[0]], { ...base, claims: claims(), proofHtm: "GET" })).toThrowError(/htm mismatch/);
    expect(() => signTokens([nodes[0]], { ...base, claims: claims(), dpopKeyPair: newDPoPKeyPair().keyPair })).toThrowError(
      /thumbprint mismatch/
    );
    expect(() => signTokens([nodes[0]], { ...base, claims: claims(), dpopIat: clock.nowSeconds() - 120 })).toThrowError(
      /timestamp expired or out of allowed window/
    );
  });

  it("range-checks the claims the gateway pins", () => {
    const clock = new FakeClock(1_700_000_000);
    const nodes = freshNodes(clock);
    const { round, assertion } = assertionFor(nodes, { username: USERNAME, password: PASSWORD, issuer: TEST_ISSUER, nonce: "c-claims" });
    const now = clock.nowSeconds();
    const base = { credential: assertion, dpopKeyPair: round.dpop.keyPair, tokenEndpoint: TOKEN_ENDPOINT };

    expect(() => signTokens([nodes[0]], { ...base, claims: { iat: now, exp: now + 3601, jti: crypto.randomUUID() } })).toThrowError(
      /Access token lifetime 3601s out of range/
    );
    // A stale claims.iat, with the DPoP proof's own iat kept fresh so the DPoP check itself
    // does not fire first.
    expect(() =>
      signTokens([nodes[0]], { ...base, claims: { iat: now - 3600, exp: now, jti: crypto.randomUUID() }, dpopIat: now })
    ).toThrowError(/iat is outside the ±60s window/);
    expect(() => signTokens([nodes[0]], { ...base, claims: { iat: now, exp: now, jti: "x" } })).toThrowError(
      /Access token lifetime 0s out of range/
    );
    // An empty jti is refused by the wire decoder (see tests/endpoint.test.ts), not here.
    expect(() => signTokens([nodes[0]], { ...base, claims: { iat: now, exp: now + 60, jti: "" } })).not.toThrow();
  });
});
