import { describe, expect, it } from "vitest";
import { createUserShares, openUserShare, sealUserShare } from "../src/register.js";
import { generateSealingKeyPair } from "../src/seal.js";
import { combineShares } from "../src/shamir.js";
import { blind, deriveServerKey, evaluate, finalize, unblind } from "../src/toprf.js";

describe("registration shares", () => {
  it("give every node a share of one k, and the h_i a sign-on with any t of them derives", () => {
    const shares = createUserShares("password123", 2, 3);
    expect(shares.map((s) => s.nodeId)).toEqual([1, 2, 3]);

    // Sign-on with nodes 2 and 3 must land on the same h the browser derived at registration.
    const { blinding, blinded } = blind("password123");
    const partials = shares.slice(1).map((s) => ({ id: s.nodeId, point: evaluate(s.toprfKeyShare, blinded) }));
    const h = finalize("password123", unblind(blinding, partials));
    for (const share of shares) expect(deriveServerKey(h, share.nodeId)).toEqual(share.h_i);
    expect(combineShares(shares.map((s) => s.toprfKeyShare))).toBe(combineShares(shares.slice(0, 2).map((s) => s.toprfKeyShare)));
  });

  it("seal to one node and open there only, under that node's id and the username", () => {
    const [share] = createUserShares("pw", 2, 3);
    const node1 = generateSealingKeyPair();
    const node2 = generateSealingKeyPair();
    const box = sealUserShare(share, "alice", node1.publicKey);

    const opened = openUserShare(node1.secretKey, box, 1, "alice");
    expect(opened.toprfKeyShare).toEqual(share.toprfKeyShare);
    expect(opened.h_i).toEqual(share.h_i);
    expect(() => openUserShare(node2.secretKey, box, 1, "alice")).toThrow();
    expect(() => openUserShare(node1.secretKey, box, 2, "alice")).toThrow();
    expect(() => openUserShare(node1.secretKey, box, 1, "alice2")).toThrow();
    expect(() => openUserShare(node1.secretKey, { ...box, ciphertext: box.ciphertext.map((b) => b ^ 1) }, 1, "alice")).toThrow();
  });
});
