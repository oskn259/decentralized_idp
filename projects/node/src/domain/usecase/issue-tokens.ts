import { verifyDPoPProof } from "@decentralized-idp/sdk/dpop";
import { FrostCommitment, FrostNonces, computeSignatureShare } from "@decentralized-idp/sdk/frost";
import { Jwt, createSigningInput } from "@decentralized-idp/sdk/jwt";
import { Grant } from "@decentralized-idp/sdk/node-api";
import { AccessTokenClaims, accessTokenJwt, refreshTokenJwt } from "@decentralized-idp/sdk/tokens";
import {
  CLOCK_SKEW_SECONDS,
  MAX_ACCESS_TOKEN_LIFETIME_SECONDS,
  REFRESH_TOKEN_LIFETIME_SECONDS,
  checkFreshness,
  checkLifetime,
  verifyAssertion,
  verifyRefreshToken,
} from "../service/credential.js";
import { tokenEndpoint } from "../value/node-identity.js";
import { IdentityNode, takeNonces } from "./identity-node.js";

export interface TokenRequest {
  /** Two rounds, because two messages are signed. One nonce pair over two messages leaks s_i. */
  accessRoundId: string;
  refreshRoundId: string;
  grant: Grant;
  /** The assertion (`authorization_code`) or the refresh token (`refresh_token`), as a JWT. */
  credential: string;
  /** RFC 9449 proof for `POST <issuer>/token`, signed by the key the credential is bound to. */
  dpopProof: string;
  claims: AccessTokenClaims;
  commitments: FrostCommitment[];
  refreshCommitments: FrostCommitment[];
  allParticipants: number[];
}

/** This node's **plaintext** shares of the two tokens. */
export interface TokenShares {
  nodeId: number;
  accessShare: bigint;
  refreshShare: bigint;
  /** `jti` of the accepted DPoP proof. */
  dpopJti: string;
}

/**
 * FROST round 2 for the access token and the next refresh token.
 *
 * Everything is checked against the credential presented, with no session to consult:
 * `sub`, `client_id`, `scope` and `cnf.jkt` come out of the verified assertion or refresh
 * token, so the gateway picks the moment of issue and nothing else. A replay within the
 * credential's window yields the same tokens, bound to the same DPoP key, and is therefore
 * not tracked.
 */
export function issueTokens(node: IdentityNode, request: TokenRequest): TokenShares {
  const { identity } = node;
  if (request.accessRoundId === request.refreshRoundId) {
    throw new Error(`Node ${identity.nodeId} needs two different rounds: access and refresh token cannot share a FROST nonce pair`);
  }
  const now = node.clock.nowSeconds();

  const credential =
    request.grant === "authorization_code"
      ? verifyAssertion(request.credential, identity, now)
      : verifyRefreshToken(request.credential, identity, now);

  const { jti: dpopJti } = verifyDPoPProof(request.dpopProof, {
    htm: "POST",
    htu: tokenEndpoint(identity),
    jkt: credential.cnf.jkt,
    now,
    maxAgeSeconds: CLOCK_SKEW_SECONDS,
  });

  const { claims } = request;
  checkFreshness("Access token", claims.iat, now);
  checkLifetime("Access token", claims.iat, claims.exp, MAX_ACCESS_TOKEN_LIFETIME_SECONDS);

  const accessNonces = takeNonces(node, request.accessRoundId);
  const refreshNonces = takeNonces(node, request.refreshRoundId);

  const share = (jwt: Jwt, nonces: FrostNonces, commitments: FrostCommitment[]): bigint =>
    computeSignatureShare(
      identity.nodeId,
      nonces,
      identity.secretKeyShare,
      createSigningInput(jwt).signingInput,
      commitments,
      identity.groupPublicKey,
      request.allParticipants
    );

  const refreshExp = claims.iat + REFRESH_TOKEN_LIFETIME_SECONDS;
  return {
    nodeId: identity.nodeId,
    accessShare: share(accessTokenJwt(identity, credential, claims), accessNonces, request.commitments),
    refreshShare: share(refreshTokenJwt(identity, credential, claims.iat, refreshExp), refreshNonces, request.refreshCommitments),
    dpopJti,
  };
}
