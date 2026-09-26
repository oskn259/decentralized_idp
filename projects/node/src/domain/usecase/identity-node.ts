import { FrostNonces } from "@decentralized-idp/sdk/frost";
import { CreditStore, PaymentTerms, Settler } from "@decentralized-idp/sdk/x402";
import { Clock } from "../infra/clock.js";
import { RoundStore } from "../infra/round-store.js";
import { UserRepository } from "../repository/user-repository.js";
import { Gateway } from "../value/gateway.js";
import { NodeIdentity } from "../value/node-identity.js";

/** Everything a use case needs: who this node is, whom it knows, its open rounds, the time, and how `/sign` is paid for. */
export interface IdentityNode {
  identity: NodeIdentity;
  users: UserRepository;
  rounds: RoundStore;
  clock: Clock;
  billing: Billing;
}

/** `/sign` is sold to the gateways as prepaid credit over x402 (`@decentralized-idp/sdk/x402`). */
export interface Billing {
  /** The callers of `/sign`; each one pays for its own calls. */
  gateways: Gateway[];
  terms: PaymentTerms;
  credits: CreditStore;
  settler: Settler;
}

export function takeNonces(node: IdentityNode, roundId: string): FrostNonces {
  const nonces = node.rounds.take(roundId);
  if (!nonces) {
    throw new Error(`Round ${roundId} expired or not found on node ${node.identity.nodeId}`);
  }
  return nonces;
}
