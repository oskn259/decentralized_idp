import { randomScalar } from "./scalar.js";
import { Share, splitSecret } from "./shamir.js";
import { deriveServerKey, finalize, hashToGroup } from "./toprf.js";

/**
 * Registration, as PASTA does it: the browser draws the user's TOPRF key k, splits it, and
 * derives h as sign-on would. Node i receives `{ k_i, h_i }` directly over TLS. Nothing else
 * ever holds k or h.
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
