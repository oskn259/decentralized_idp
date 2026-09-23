import { Commitment, FrostCommitment } from "@decentralized-idp/sdk/frost";
import { Grant } from "@decentralized-idp/sdk/node-api";
import { AccessTokenClaims } from "@decentralized-idp/sdk/tokens";

/**
 * One identity node, as the gateway talks to it. The shapes mirror the node's own
 * `/commit`, `/sign-on` and `/sign`; `infra/node.ts`'s `HttpNode` carries them over HTTP.
 */
export interface Node {
  readonly nodeId: number;
  readonly url: string;
  /** FROST round 1: opens `roundId` on the node and returns its commitment. */
  commit(roundId: string): Promise<Commitment>;
  signOn(request: NodeSignOnRequest): Promise<NodeSignOnResponse>;
  sign(request: NodeTokenRequest): Promise<NodeTokenShares>;
  health(timeoutMs?: number): Promise<NodeHealth>;
}

export interface NodeHealth {
  nodeId: number;
  groupPublicKey: Uint8Array;
}

export interface NodeSignOnRequest {
  roundId: string;
  username: string;
  /** A = r·H1(password) */
  blinded: Uint8Array;
  sessionNonce: Uint8Array;
  cnfJkt: string;
  clientId: string;
  scope: string;
  nonce?: string;
  iat: number;
  exp: number;
  commitments: FrostCommitment[];
  allParticipants: number[];
}

export interface NodeSignOnResponse {
  nodeId: number;
  /** B_i = k_i·A */
  toprfPartial: Uint8Array;
  /** AEAD_{h_i}(z_i); the gateway holds no h_i and relays it as is. */
  ct_i: Uint8Array;
  sub: string;
}

export interface NodeTokenRequest {
  accessRoundId: string;
  refreshRoundId: string;
  grant: Grant;
  /** The assertion or the refresh token being spent. */
  credential: string;
  dpopProof: string;
  claims: AccessTokenClaims;
  commitments: FrostCommitment[];
  refreshCommitments: FrostCommitment[];
  allParticipants: number[];
}

/** Plaintext FROST shares of the access token and of the next refresh token. */
export interface NodeTokenShares {
  nodeId: number;
  accessShare: bigint;
  refreshShare: bigint;
}
