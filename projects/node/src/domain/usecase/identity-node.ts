import { FrostNonces } from "@decentralized-idp/sdk/frost";
import { Clock } from "../infra/clock.js";
import { RoundStore } from "../infra/round-store.js";
import { UserRepository } from "../repository/user-repository.js";
import { NodeIdentity } from "../value/node-identity.js";

/** Everything a use case needs: who this node is, whom it knows, its open rounds, the time. */
export interface IdentityNode {
  identity: NodeIdentity;
  users: UserRepository;
  rounds: RoundStore;
  clock: Clock;
}

export function takeNonces(node: IdentityNode, roundId: string): FrostNonces {
  const nonces = node.rounds.take(roundId);
  if (!nonces) {
    throw new Error(`Round ${roundId} expired or not found on node ${node.identity.nodeId}`);
  }
  return nonces;
}
