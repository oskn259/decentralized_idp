import { utf8 } from "./bytes.js";
import { bigIntToHex, bytesToHex, hexToBigInt, hexToBytes } from "./hex.js";
import { deterministicJsonStringify } from "./jwt.js";
import { randomScalar } from "./scalar.js";
import { SealedBox, open, seal } from "./seal.js";
import { Share, splitSecret } from "./shamir.js";
import { deriveServerKey, finalize, hashToGroup } from "./toprf.js";

/**
 * Registration, the browser's side and the node's side. The browser draws the user's TOPRF
 * key k, splits it, derives h as sign-on would, and seals node i's share `{ k_i, h_i }` to
 * node i alone. The gateway assigns `sub` and relays; it never sees a share.
 *
 * Sealed plaintext: `{"h_i":"<hex 64>","k_i":"<hex 64>"}` (deterministic JSON).
 * AAD: `{"nodeId":<i>,"username":"<username>"}` (deterministic JSON), so a box opens only
 * on the node and under the username it was made for.
 */

export interface UserShare {
  nodeId: number;
  toprfKeyShare: Share;
  h_i: Uint8Array;
}

/** One share per node. `k` is drawn fresh unless a test vector pins it. */
export function createUserShares(password: string, threshold: number, total: number, k = randomScalar()): UserShare[] {
  const h = finalize(password, hashToGroup(password).multiply(k));
  return splitSecret(k, threshold, total).map((share) => ({ nodeId: share.id, toprfKeyShare: share, h_i: deriveServerKey(h, share.id) }));
}

function shareAad(nodeId: number, username: string): Uint8Array {
  return utf8(deterministicJsonStringify({ nodeId, username }));
}

export function sealUserShare(share: UserShare, username: string, nodePublicKey: Uint8Array, ephemeralSecretKey?: Uint8Array): SealedBox {
  const plaintext = utf8(deterministicJsonStringify({ h_i: bytesToHex(share.h_i), k_i: bigIntToHex(share.toprfKeyShare.value) }));
  return seal(nodePublicKey, plaintext, shareAad(share.nodeId, username), ephemeralSecretKey);
}

/** Node `nodeId` reads its share for `username`. Throws when the box was not sealed for exactly that. */
export function openUserShare(secretKey: Uint8Array, box: SealedBox, nodeId: number, username: string): UserShare {
  const plaintext = open(secretKey, box, shareAad(nodeId, username));
  const { h_i, k_i } = JSON.parse(new TextDecoder().decode(plaintext)) as { h_i: string; k_i: string };
  const h = hexToBytes(h_i);
  if (h.length !== 32) {
    throw new Error(`h_i must be 32 bytes, got ${h.length}`);
  }
  return { nodeId, toprfKeyShare: { id: nodeId, value: hexToBigInt(k_i) }, h_i: h };
}
