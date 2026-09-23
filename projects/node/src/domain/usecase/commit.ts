import { IdentityNode } from "./identity-node.js";
import { Commitment, generateNonces } from "@decentralized-idp/sdk/frost";

/** FROST round 1: open a round and publish this node's commitment (D_i, E_i). */
export function commit(node: IdentityNode, roundId: string): Commitment {
  const { nonces, commitment } = generateNonces();
  node.rounds.open(roundId, nonces);
  return commitment;
}
