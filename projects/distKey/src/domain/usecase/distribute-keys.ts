import { publicKeyOf } from "@decentralized-idp/sdk/frost";
import { randomScalar } from "@decentralized-idp/sdk/scalar";
import { splitSecret } from "@decentralized-idp/sdk/shamir";

export interface NodeKeys {
  nodeId: number;
  /** s_i */
  secretKeyShare: bigint;
}

export interface DistributedKeys {
  threshold: number;
  total: number;
  /** Y = s·B, the key every token is verified against. */
  groupPublicKey: Uint8Array;
  nodes: NodeKeys[];
}

/**
 * The trusted dealer's one job: one group signing key split t-of-n (node i gets s_i, everyone
 * gets Y). The dealer is the only party that sees the whole group key and every share. Users
 * register themselves later, from the browser.
 */
export function distributeKeys(threshold: number, total: number): DistributedKeys {
  const groupSecret = randomScalar();
  const nodes = splitSecret(groupSecret, threshold, total).map((share) => ({ nodeId: share.id, secretKeyShare: share.value }));
  return { threshold, total, groupPublicKey: publicKeyOf(groupSecret), nodes };
}
