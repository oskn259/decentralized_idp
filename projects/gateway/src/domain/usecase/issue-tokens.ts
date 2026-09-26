import { verifyDPoPProof } from "@decentralized-idp/sdk/dpop";
import { FrostCommitment, aggregateSignatureShares, computeGroupCommitment } from "@decentralized-idp/sdk/frost";
import { Jwt, assembleJwt, createSigningInput, decodeJwt } from "@decentralized-idp/sdk/jwt";
import { Grant } from "@decentralized-idp/sdk/node-api";
import { CredentialClaims, accessTokenJwt, credentialClaimsOf, refreshTokenJwt } from "@decentralized-idp/sdk/tokens";
import { tokenEndpointUrl } from "../value/group.js";
import { Gateway, openRounds, participantNodes } from "./gateway.js";
import { OAuthError } from "./oauth-error.js";

export const ACCESS_TOKEN_LIFETIME_SECONDS = 3600;
export const REFRESH_TOKEN_LIFETIME_SECONDS = 86400 * 30;
/** How far a DPoP proof's `iat` may sit from the gateway's clock. */
export const DPOP_MAX_AGE_SECONDS = 60;

export interface TokenRequest {
  grant: Grant;
  /** `authorization_code`: the assertion (= code). `refresh_token`: a refresh token this group signed. */
  credential: string;
  /** RFC 9449 proof for `POST <issuer>/token`. */
  dpopProof: string;
  /** The client, already authenticated (`authenticateClient`). */
  clientId: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  clientId: string;
  cnfJkt: string;
  participants: number[];
  excluded: number[];
}

/**
 * Turns a credential plus a DPoP proof into an access token and the next refresh token.
 *
 * The credential must have been issued to the authenticated client. The
 * gateway reads the credential without verifying it (the nodes do that, each for
 * itself) and checks only that the proof's key is the one the credential is bound to. It
 * then pins the moment of issue, runs two FROST rounds, and adds up the plaintext shares
 * into two group signatures. It keeps nothing: the refresh token is itself group-signed.
 */
export async function issueTokens(gateway: Gateway, request: TokenRequest): Promise<IssuedTokens> {
  const { group } = gateway;
  const { clientId } = request;
  const claims = readClaims(request.credential);
  if (claims.client_id !== clientId) {
    throw new OAuthError("invalid_grant", "credential was issued to another client");
  }
  const now = gateway.clock.nowSeconds();
  verifyProof(request.dpopProof, tokenEndpointUrl(group), claims.cnf.jkt, now);

  const accessRoundId = crypto.randomUUID();
  const refreshRoundId = crypto.randomUUID();
  const rounds = await openRounds(gateway, [accessRoundId, refreshRoundId]).catch((err) => {
    // Too few nodes to sign: to the client, this credential cannot be exchanged right now.
    throw new OAuthError("invalid_grant", err.message);
  });
  const [commitments, refreshCommitments] = rounds.commitments;

  const accessClaims = { iat: now, exp: now + ACCESS_TOKEN_LIFETIME_SECONDS, jti: crypto.randomUUID() };
  const refreshExp = now + REFRESH_TOKEN_LIFETIME_SECONDS;

  const shares = await Promise.all(
    participantNodes(gateway, rounds.participants).map((node) =>
      node.sign({
        accessRoundId,
        refreshRoundId,
        grant: request.grant,
        credential: request.credential,
        dpopProof: request.dpopProof,
        claims: accessClaims,
        commitments,
        refreshCommitments,
        allParticipants: rounds.participants,
      })
    )
  ).catch((err) => {
    // A node refused the credential or the proof: the caller cannot mint a token with it.
    throw new OAuthError("invalid_grant", err.message);
  });

  return {
    accessToken: aggregate(accessTokenJwt(group, claims, accessClaims), commitments, shares.map((s) => s.accessShare)),
    refreshToken: aggregate(refreshTokenJwt(group, claims, now, refreshExp), refreshCommitments, shares.map((s) => s.refreshShare)),
    expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
    scope: claims.scope,
    clientId,
    cnfJkt: claims.cnf.jkt,
    participants: rounds.participants,
    excluded: rounds.excluded,
  };
}

/** The identity fields of the credential, unverified: enough to rebuild what the nodes sign. */
function readClaims(credential: string): CredentialClaims {
  try {
    return credentialClaimsOf(decodeJwt(credential).payload);
  } catch (err) {
    throw new OAuthError("invalid_grant", `credential: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The proof must be for `POST <issuer>/token`, fresh, and signed by the key the credential is bound to. */
function verifyProof(dpopProof: string, htu: string, jkt: string, now: number): void {
  try {
    verifyDPoPProof(dpopProof, { htm: "POST", htu, jkt, now, maxAgeSeconds: DPOP_MAX_AGE_SECONDS });
  } catch (err) {
    throw new OAuthError("invalid_dpop_proof", err instanceof Error ? err.message : String(err));
  }
}

/** The same bytes every node signed, with the shares added up into one Ed25519 signature. */
function aggregate(jwt: Jwt, commitments: FrostCommitment[], shares: bigint[]): string {
  const { signingInput, headerB64, payloadB64 } = createSigningInput(jwt);
  const R = computeGroupCommitment(signingInput, commitments);
  return assembleJwt(headerB64, payloadB64, aggregateSignatureShares(R, shares));
}
