import { DistributedKeys, distributeKeys, NodeUser, UserSpec } from "../src/domain/usecase/distribute-keys.js";
import { publicKeyOf } from "@decentralized-idp/sdk/frost";
import { bytesToHex } from "@decentralized-idp/sdk/hex";
import { combineShares, Share } from "@decentralized-idp/sdk/shamir";
import { blind, deriveServerKey, evaluate, finalize, unblind } from "@decentralized-idp/sdk/toprf";
import { describe, expect, it } from "vitest";

/** Recomputes h exactly as the browser would at sign-on, from any `threshold` of the per-node shares. */
function masterKeyOf(password: string, shares: Share[]): Uint8Array {
  const { blinding, blinded } = blind(password);
  const partials = shares.map((share) => ({ id: share.id, point: evaluate(share, blinded) }));
  return finalize(password, unblind(blinding, partials));
}

function signingShares(keys: DistributedKeys): Share[] {
  return keys.nodes.map((n) => ({ id: n.nodeId, value: n.secretKeyShare }));
}

/** One user's record on each node, in node order. */
function recordsOf(keys: DistributedKeys, username: string): NodeUser[] {
  return keys.nodes.map((n) => n.users.find((u) => u.username === username)!);
}

const USERS: UserSpec[] = [
  { username: "alice", password: "correct horse battery staple", sub: "usr_alice" },
  { username: "bob", password: "hunter2000", sub: "usr_bob" },
];

describe("distributeKeys", () => {
  it("any threshold of the signing shares combine to a secret whose public key is groupPublicKey", () => {
    const keys = distributeKeys(2, 3, USERS);
    const shares = signingShares(keys);

    for (const quorum of [[shares[0], shares[1]], [shares[1], shares[2]], [shares[0], shares[2]], shares]) {
      const secret = combineShares(quorum);
      expect(bytesToHex(publicKeyOf(secret))).toBe(bytesToHex(keys.groupPublicKey));
    }
  });

  it("fewer than threshold shares do not recover the group secret", () => {
    const keys = distributeKeys(2, 3, USERS);
    const [share] = signingShares(keys);
    const secret = combineShares([share]);
    expect(bytesToHex(publicKeyOf(secret))).not.toBe(bytesToHex(keys.groupPublicKey));
  });

  it("for each user, any threshold of the per-node TOPRF shares recompute h_i on every node, and match", () => {
    const keys = distributeKeys(2, 3, USERS);

    for (const user of USERS) {
      const records = recordsOf(keys, user.username);
      const stored = records.map((r) => bytesToHex(r.h_i));
      for (const quorum of [[records[0], records[1]], [records[1], records[2]], [records[0], records[2]]]) {
        const h = masterKeyOf(user.password, quorum.map((r) => r.toprfKeyShare));
        const recomputed = records.map((r) => bytesToHex(deriveServerKey(h, r.toprfKeyShare.id)));
        expect(recomputed).toEqual(stored);
      }
    }
  });

  it("a wrong password yields different h_i than the registered password", () => {
    const keys = distributeKeys(2, 3, USERS);
    const alice = recordsOf(keys, "alice");
    const shares = [alice[0].toprfKeyShare, alice[1].toprfKeyShare];

    const wrongH = masterKeyOf("wrong password", shares);
    expect(bytesToHex(deriveServerKey(wrongH, alice[0].toprfKeyShare.id))).not.toBe(bytesToHex(alice[0].h_i));
  });

  it("each user gets an independent TOPRF key: their shares differ", () => {
    const keys = distributeKeys(2, 3, USERS);
    const node = keys.nodes[0];
    const alice = node.users.find((u) => u.username === "alice")!;
    const bob = node.users.find((u) => u.username === "bob")!;
    expect(alice.toprfKeyShare.value).not.toBe(bob.toprfKeyShare.value);
  });

  it("every node lists every user, in the same order", () => {
    const keys = distributeKeys(2, 3, USERS);
    const expectedOrder = USERS.map((u) => u.username);
    for (const node of keys.nodes) {
      expect(node.users.map((u) => u.username)).toEqual(expectedOrder);
    }
  });

  it("toprfKeyShare.id equals the owning node's nodeId", () => {
    const keys = distributeKeys(2, 3, USERS);
    for (const node of keys.nodes) {
      expect(node.users.map((u) => u.toprfKeyShare.id)).toEqual(node.users.map(() => node.nodeId));
    }
  });

  it("rejects a duplicate username", () => {
    const dup: UserSpec[] = [
      { username: "alice", password: "p1", sub: "s1" },
      { username: "alice", password: "p2", sub: "s2" },
    ];
    expect(() => distributeKeys(2, 3, dup)).toThrowError(/duplicate username/);
  });

  it("rejects a threshold greater than total (propagated from splitSecret)", () => {
    expect(() => distributeKeys(4, 3, USERS)).toThrowError(/Invalid threshold/);
  });

  it("two runs produce different keys", () => {
    const a = distributeKeys(2, 3, USERS);
    const b = distributeKeys(2, 3, USERS);
    expect(bytesToHex(a.groupPublicKey)).not.toBe(bytesToHex(b.groupPublicKey));
    expect(a.nodes[0].secretKeyShare).not.toBe(b.nodes[0].secretKeyShare);
    expect(bytesToHex(a.nodes[0].users[0].h_i)).not.toBe(bytesToHex(b.nodes[0].users[0].h_i));
  });
});
