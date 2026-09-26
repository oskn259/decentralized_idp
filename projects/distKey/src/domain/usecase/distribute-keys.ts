import { DPoPKeyPair, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { publicKeyOf } from "@decentralized-idp/sdk/frost";
import { randomScalar } from "@decentralized-idp/sdk/scalar";
import { splitSecret } from "@decentralized-idp/sdk/shamir";

export interface NodeKeys {
  nodeId: number;
  /** s_i */
  secretKeyShare: bigint;
}

/** A relying party's key for `private_key_jwt`: an ordinary Ed25519 pair, the same shape as a DPoP key. */
export interface ClientKeys {
  clientId: string;
  keyPair: DPoPKeyPair;
}

export interface DistributedKeys {
  threshold: number;
  total: number;
  /** Y = s·B, the key every token is verified against. */
  groupPublicKey: Uint8Array;
  nodes: NodeKeys[];
  clients: ClientKeys[];
}

/**
 * The trusted dealer's job: one group signing key split t-of-n (node i gets s_i, everyone
 * gets Y), and, for the demo, a client-authentication key pair per relying party. The dealer
 * is the only party that sees the whole group key and every share. Users register themselves
 * later, from the browser.
 */
export function distributeKeys(threshold: number, total: number, clientIds: string[]): DistributedKeys {
  const groupSecret = randomScalar();
  const nodes = splitSecret(groupSecret, threshold, total).map((share) => ({ nodeId: share.id, secretKeyShare: share.value }));
  const clients = clientIds.map((clientId) => ({ clientId, keyPair: generateDPoPKeyPair() }));
  return { threshold, total, groupPublicKey: publicKeyOf(groupSecret), nodes, clients };
}
