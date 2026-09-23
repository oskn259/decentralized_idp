import { Jwt } from "./jwt.js";

/**
 * The three JWTs the group signs, told apart only by `typ`: the assertion (= authorization
 * code), the access token and the refresh token. Every signer and the aggregator build the
 * same header and payload from here, so their shares add up to one signature.
 */

export const ASSERTION_TYP = "JWT";
export const ACCESS_TOKEN_TYP = "at+jwt";
export const REFRESH_TOKEN_TYP = "refresh+jwt";

/** Who signs: the `iss` and the `kid` of every token. */
export interface TokenIssuer {
  issuer: string;
  keyId: string;
}

/** The identity an assertion or a refresh token carries, and an access token is built from. */
export interface CredentialClaims {
  sub: string;
  client_id: string;
  scope: string;
  cnf: { jkt: string };
}

/** The access token claims the gateway pins so that all nodes sign byte-identical tokens. */
export interface AccessTokenClaims {
  iat: number;
  exp: number;
  jti: string;
}

export interface AssertionRequest {
  clientId: string;
  scope: string;
  cnfJkt: string;
  nonce?: string;
  iat: number;
  exp: number;
}

/** `sub` comes from the node's own user record, never from the request. */
export function assertionJwt(by: TokenIssuer, sub: string, request: AssertionRequest): Jwt {
  return {
    header: { alg: "EdDSA", typ: ASSERTION_TYP, kid: by.keyId },
    payload: {
      iss: by.issuer,
      sub,
      aud: by.issuer,
      client_id: request.clientId,
      scope: request.scope,
      cnf: { jkt: request.cnfJkt },
      nonce: request.nonce,
      iat: request.iat,
      exp: request.exp,
    },
  };
}

/** Everything but the moment of issue is copied from the credential being spent. */
export function accessTokenJwt(by: TokenIssuer, credential: CredentialClaims, claims: AccessTokenClaims): Jwt {
  return {
    header: { alg: "EdDSA", typ: ACCESS_TOKEN_TYP, kid: by.keyId },
    payload: {
      iss: by.issuer,
      sub: credential.sub,
      aud: credential.client_id,
      scope: credential.scope,
      cnf: { jkt: credential.cnf.jkt },
      iat: claims.iat,
      exp: claims.exp,
      jti: claims.jti,
    },
  };
}

export function refreshTokenJwt(by: TokenIssuer, credential: CredentialClaims, iat: number, exp: number): Jwt {
  return {
    header: { alg: "EdDSA", typ: REFRESH_TOKEN_TYP, kid: by.keyId },
    payload: {
      iss: by.issuer,
      sub: credential.sub,
      client_id: credential.client_id,
      scope: credential.scope,
      cnf: { jkt: credential.cnf.jkt },
      iat,
      exp,
    },
  };
}

/**
 * Reads the identity fields out of a decoded payload, naming the first one missing.
 * Whether the payload's signature was checked is the caller's business.
 */
export function credentialClaimsOf(payload: Record<string, unknown>): CredentialClaims {
  const text = (name: string): string => {
    const value = payload[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${name} is missing`);
    }
    return value;
  };
  const jkt = (payload.cnf as { jkt?: unknown } | undefined)?.jkt;
  if (typeof jkt !== "string" || jkt.length === 0) {
    throw new Error("cnf.jkt is missing");
  }
  return {
    sub: text("sub"),
    client_id: text("client_id"),
    // An empty scope is a legitimate authorize request.
    scope: typeof payload.scope === "string" ? payload.scope : "",
    cnf: { jkt },
  };
}
