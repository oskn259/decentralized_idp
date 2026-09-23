import { ristretto255 } from "@noble/curves/ed25519";
import { aeadEncrypt, deriveAeadNonce } from "@decentralized-idp/sdk/aead";
import { utf8 } from "@decentralized-idp/sdk/bytes";
import { FrostCommitment, computeSignatureShare } from "@decentralized-idp/sdk/frost";
import { createSigningInput } from "@decentralized-idp/sdk/jwt";
import { SignOnResponse } from "@decentralized-idp/sdk/node-api";
import { assertionJwt } from "@decentralized-idp/sdk/tokens";
import { evaluate } from "@decentralized-idp/sdk/toprf";
import { MAX_ASSERTION_LIFETIME_SECONDS, checkFreshness, checkLifetime } from "../service/credential.js";
import { IdentityNode, takeNonces } from "./identity-node.js";

export interface SignOnInput {
  roundId: string;
  username: string;
  /** A = r·H1(password), a Ristretto255 point. */
  blinded: Uint8Array;
  /** Client randomness the AEAD nonce is derived from. */
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

/**
 * FROST round 2 for the authentication assertion.
 *
 * The node never sees the password: it evaluates the TOPRF on the blinded point, signs the
 * assertion with its share, and returns that share encrypted under h_i. Only a client that
 * can recompute h from the password can decrypt it and assemble the assertion.
 */
/** Returns B_i = k_i·A as `toprfPartial` and ct_i = AEAD_{h_i}(z_i) as `ct_i`, AAD = the assertion's signing input. */
export function signOn(node: IdentityNode, request: SignOnInput): SignOnResponse {
  const { identity } = node;
  const user = node.users.findByUsername(request.username);
  if (!user) {
    throw new Error(`User not found on node ${identity.nodeId}`);
  }
  checkFreshness("Assertion", request.iat, node.clock.nowSeconds());
  checkLifetime("Assertion", request.iat, request.exp, MAX_ASSERTION_LIFETIME_SECONDS);
  // Refuse a malformed point before the round's nonces are spent on it.
  const blinded = ristretto255.Point.fromBytes(request.blinded);
  const nonces = takeNonces(node, request.roundId);

  const partial = evaluate(user.toprfKeyShare, blinded);

  const { signingInput } = createSigningInput(assertionJwt(identity, user.sub, request));
  const z_i = computeSignatureShare(
    identity.nodeId,
    nonces,
    identity.secretKeyShare,
    signingInput,
    request.commitments,
    identity.groupPublicKey,
    request.allParticipants
  );

  const ct_i = aeadEncrypt(
    user.h_i,
    deriveAeadNonce(request.sessionNonce, identity.nodeId),
    utf8(JSON.stringify({ z_i: z_i.toString() })),
    signingInput
  );

  return { nodeId: identity.nodeId, toprfPartial: partial.toRawBytes(), ct_i, sub: user.sub };
}
