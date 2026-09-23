import { FrostNonces } from "@decentralized-idp/sdk/frost";

/**
 * The node's only mutable state: the nonces of FROST rounds that were opened by `/commit`
 * and not yet spent. A nonce pair signs exactly one message, so `take` removes it.
 */
export interface RoundStore {
  open(roundId: string, nonces: FrostNonces): void;
  take(roundId: string): FrostNonces | undefined;
}
