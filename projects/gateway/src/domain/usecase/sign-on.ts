import { FrostCommitment } from "@decentralized-idp/sdk/frost";
import { NodeSignOnResponse } from "../infra/node.js";
import { Gateway, openRounds, participantNodes } from "./gateway.js";

/** What the browser sends: the blinded password and the claims it wants in its assertion. */
export interface SignOnRequest {
  username: string;
  /** A = r·H1(password). The gateway cannot unblind it. */
  blinded: Uint8Array;
  sessionNonce: Uint8Array;
  cnfJkt: string;
  clientId: string;
  scope: string;
  /** The challenge `c` handed out by `/authorize`. */
  nonce: string;
  iat: number;
  exp: number;
}

/** What the browser needs to assemble the assertion: R's ingredients and every node's ciphertext. */
export interface SignOnResponse {
  roundId: string;
  participants: number[];
  excluded: number[];
  commitments: FrostCommitment[];
  shares: NodeSignOnResponse[];
}

/**
 * Relays the two FROST rounds of a sign-on. The gateway sees the blinded point going in
 * and encrypted shares coming out; holding neither the password nor any h_i, it can
 * neither read nor forge the assertion, and it remembers nothing afterwards.
 */
export async function signOn(gateway: Gateway, request: SignOnRequest): Promise<SignOnResponse> {
  const roundId = crypto.randomUUID();
  const rounds = await openRounds(gateway, [roundId]);
  const commitments = rounds.commitments[0];

  // Round 2 is all or nothing: R and the Lagrange weights are fixed by the commitment set.
  const shares = await Promise.all(
    participantNodes(gateway, rounds.participants).map((node) =>
      node.signOn({ roundId, ...request, commitments, allParticipants: rounds.participants })
    )
  );

  return { roundId, participants: rounds.participants, excluded: rounds.excluded, commitments, shares };
}
