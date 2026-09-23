import { describe, expect, it } from "vitest";
import { calculateJwkThumbprint, createDPoPProof, exportDPoPJwk, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { assembleJwt, createSigningInput, decodeJwt } from "@decentralized-idp/sdk/jwt";
import { assertionJwt } from "@decentralized-idp/sdk/tokens";
import { Gateway, openRounds } from "../src/domain/usecase/gateway.js";
import { OAuthError, issueTokens } from "../src/domain/usecase/issue-tokens.js";
import { SignOnRequest, signOn } from "../src/domain/usecase/sign-on.js";
import { Group } from "../src/domain/value/group.js";
import { TestClock } from "./helpers/clock.js";
import { FakeNode } from "./helpers/fake-node.js";

/** The use cases against fake `Node`s. Wire encoding is infra.test.ts's, the real node e2e.test.ts's. */

const ISSUER = "http://localhost:3000";
const KEY_ID = "pasta-group-key-1";

function group(threshold: number): Group {
  return { issuer: ISSUER, threshold, groupPublicKey: new Uint8Array(32), keyId: KEY_ID };
}

describe("openRounds", () => {
  it("excludes a node that fails to commit, keeps ascending participants, and keeps commitments in request order", async () => {
    const nodes = [new FakeNode(1), new FakeNode(2, { commitFails: true }), new FakeNode(3)];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock() };

    const rounds = await openRounds(gateway, ["round-a", "round-b"]);

    expect(rounds.participants).toEqual([1, 3]);
    expect(rounds.excluded).toEqual([2]);
    expect(rounds.commitments).toHaveLength(2);
    expect(rounds.commitments[0].map((c) => c.nodeId)).toEqual([1, 3]);
    expect(rounds.commitments[1].map((c) => c.nodeId)).toEqual([1, 3]);
    // Every node, the failing one included, is asked for each round once, in request order.
    expect(nodes[0].commitCalls).toEqual(["round-a", "round-b"]);
    expect(nodes[1].commitCalls).toEqual(["round-a", "round-b"]);
    expect(nodes[2].commitCalls).toEqual(["round-a", "round-b"]);
  });

  it("keeps ascending participant order regardless of which nodes answered first", async () => {
    // `gateway.nodes` is deliberately unsorted: the ascending order must be openRounds's own.
    const nodes = [new FakeNode(3), new FakeNode(1), new FakeNode(2)];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock() };
    const rounds = await openRounds(gateway, ["r"]);
    expect(rounds.participants).toEqual([1, 2, 3]);
    expect(rounds.commitments[0].map((c) => c.nodeId)).toEqual([1, 2, 3]);
  });

  it("throws the documented quorum message, naming every unreachable node ascending", async () => {
    const nodes = [new FakeNode(1), new FakeNode(2, { commitFails: true }), new FakeNode(3, { commitFails: true })];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock() };

    await expect(openRounds(gateway, ["r"])).rejects.toThrow("quorum 1 < 2 (node2, node3 unreachable)");
  });

  it("omits the parenthetical when nothing is excluded but quorum still fails (threshold above total)", async () => {
    const nodes = [new FakeNode(1)];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock() };
    await expect(openRounds(gateway, ["r"])).rejects.toThrow("quorum 1 < 2");
    await expect(openRounds(gateway, ["r"])).rejects.not.toThrow(/\(/);
  });
});

describe("signOn", () => {
  const request: SignOnRequest = {
    username: "alice",
    blinded: new Uint8Array(32).fill(7),
    sessionNonce: new Uint8Array(16).fill(9),
    cnfJkt: "jkt-value-000000000000000000000000000",
    clientId: "demo_client",
    scope: "openid profile",
    nonce: "n-1",
    iat: 1_700_000_000,
    exp: 1_700_000_030,
  };

  it("relays round 1 and round 2, returning participants, excluded and per-node shares", async () => {
    const nodes = [new FakeNode(1), new FakeNode(2, { commitFails: true }), new FakeNode(3)];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock() };

    const res = await signOn(gateway, request);

    expect(res.participants).toEqual([1, 3]);
    expect(res.excluded).toEqual([2]);
    expect(res.shares.map((s) => s.nodeId)).toEqual([1, 3]);
    expect(res.commitments.map((c) => c.nodeId)).toEqual([1, 3]);
    const node1 = nodes[0];
    expect(node1.signOnCalls).toHaveLength(1);
    expect(node1.signOnCalls[0].username).toBe("alice");
    expect(node1.signOnCalls[0].allParticipants).toEqual([1, 3]);
    expect(node1.signOnCalls[0].commitments.map((c) => c.nodeId)).toEqual([1, 3]);
    expect(nodes[1].signOnCalls).toHaveLength(0);
  });

  it("propagates a quorum failure unwrapped", async () => {
    const nodes = [new FakeNode(1), new FakeNode(2, { commitFails: true }), new FakeNode(3, { commitFails: true })];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock() };
    await expect(signOn(gateway, request)).rejects.toThrow("quorum 1 < 2 (node2, node3 unreachable)");
  });
});

describe("issueTokens", () => {
  const NOW = 1_700_000_000;

  function credentialFor(cnfJkt: string): string {
    const jwt = assertionJwt(
      { issuer: ISSUER, keyId: KEY_ID },
      "usr_test_12345",
      { clientId: "demo_client", scope: "openid profile", cnfJkt, iat: NOW, exp: NOW + 30 }
    );
    const { headerB64, payloadB64 } = createSigningInput(jwt);
    // The gateway never verifies the credential's signature, so any 64 bytes serve here.
    return assembleJwt(headerB64, payloadB64, new Uint8Array(64));
  }

  it("aggregates a matching access token and refresh token from a quorum of nodes", async () => {
    const keyPair = generateDPoPKeyPair();
    const jkt = calculateJwkThumbprint(exportDPoPJwk(keyPair.publicKey));
    const credential = credentialFor(jkt);
    const proof = createDPoPProof(keyPair, "POST", `${ISSUER}/token`, NOW);

    const nodes = [new FakeNode(1), new FakeNode(2), new FakeNode(3)];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock(NOW) };

    const issued = await issueTokens(gateway, { grant: "authorization_code", credential, dpopProof: proof });

    expect(issued.participants).toEqual([1, 2, 3]);
    expect(issued.excluded).toEqual([]);
    expect(issued.cnfJkt).toBe(jkt);
    expect(issued.expiresIn).toBe(3600);
    expect(issued.scope).toBe("openid profile");

    const at = decodeJwt(issued.accessToken);
    expect(at.header.typ).toBe("at+jwt");
    expect(at.payload.aud).toBe("demo_client");
    expect(at.payload.cnf).toEqual({ jkt });
    expect((at.payload.exp as number) - (at.payload.iat as number)).toBe(3600);

    const rt = decodeJwt(issued.refreshToken);
    expect(rt.header.typ).toBe("refresh+jwt");
    expect(rt.payload.cnf).toEqual({ jkt });
  });

  it("excludes a down node but still succeeds when quorum holds", async () => {
    const keyPair = generateDPoPKeyPair();
    const jkt = calculateJwkThumbprint(exportDPoPJwk(keyPair.publicKey));
    const credential = credentialFor(jkt);
    const proof = createDPoPProof(keyPair, "POST", `${ISSUER}/token`, NOW);

    const nodes = [new FakeNode(1), new FakeNode(2, { commitFails: true }), new FakeNode(3)];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock(NOW) };

    const issued = await issueTokens(gateway, { grant: "authorization_code", credential, dpopProof: proof });
    expect(issued.participants).toEqual([1, 3]);
    expect(issued.excluded).toEqual([2]);
  });

  it("maps an undecodable credential to invalid_grant", async () => {
    const nodes = [new FakeNode(1), new FakeNode(2), new FakeNode(3)];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock(NOW) };

    const err = await issueTokens(gateway, { grant: "authorization_code", credential: "not-a-jwt", dpopProof: "unused" }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("invalid_grant");
    expect((err as OAuthError).message).toContain("credential:");
  });

  it("maps a DPoP proof bound to another key to invalid_dpop_proof", async () => {
    const credentialKeyPair = generateDPoPKeyPair();
    const jkt = calculateJwkThumbprint(exportDPoPJwk(credentialKeyPair.publicKey));
    const credential = credentialFor(jkt);

    const otherKeyPair = generateDPoPKeyPair();
    const foreignProof = createDPoPProof(otherKeyPair, "POST", `${ISSUER}/token`, NOW);

    const nodes = [new FakeNode(1), new FakeNode(2), new FakeNode(3)];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock(NOW) };

    const err = await issueTokens(gateway, { grant: "authorization_code", credential, dpopProof: foreignProof }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("invalid_dpop_proof");

    for (const node of nodes) expect(node.commitCalls).toEqual([]);
  });

  it("maps a node's refusal to sign to invalid_grant", async () => {
    const keyPair = generateDPoPKeyPair();
    const jkt = calculateJwkThumbprint(exportDPoPJwk(keyPair.publicKey));
    const credential = credentialFor(jkt);
    const proof = createDPoPProof(keyPair, "POST", `${ISSUER}/token`, NOW);

    const nodes = [new FakeNode(1), new FakeNode(2, { signFails: "node 2 rejects: bad credential" }), new FakeNode(3)];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock(NOW) };

    const err = await issueTokens(gateway, { grant: "authorization_code", credential, dpopProof: proof }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("invalid_grant");
    expect((err as OAuthError).message).toContain("node 2 rejects: bad credential");
  });

  it("maps a quorum failure while signing to invalid_grant", async () => {
    const keyPair = generateDPoPKeyPair();
    const jkt = calculateJwkThumbprint(exportDPoPJwk(keyPair.publicKey));
    const credential = credentialFor(jkt);
    const proof = createDPoPProof(keyPair, "POST", `${ISSUER}/token`, NOW);

    const nodes = [new FakeNode(1), new FakeNode(2, { commitFails: true }), new FakeNode(3, { commitFails: true })];
    const gateway: Gateway = { group: group(2), nodes, clock: new TestClock(NOW) };

    const err = await issueTokens(gateway, { grant: "authorization_code", credential, dpopProof: proof }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("invalid_grant");
    expect((err as OAuthError).message).toContain("quorum 1 < 2");
  });
});
