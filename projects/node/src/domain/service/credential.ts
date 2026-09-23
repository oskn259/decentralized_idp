import { Jwt, verifyJwt } from "@decentralized-idp/sdk/jwt";
import {
  ASSERTION_TYP,
  CredentialClaims,
  REFRESH_TOKEN_TYP,
  credentialClaimsOf,
} from "@decentralized-idp/sdk/tokens";
import { NodeIdentity } from "../value/node-identity.js";

/**
 * What this node checks before it spends its share on a credential presented at `/sign`.
 * The token layouts themselves are shared with the gateway (`@decentralized-idp/sdk/tokens`).
 */

/** An assertion is spendable at `/sign` for this long after it was issued. */
export const MAX_ASSERTION_LIFETIME_SECONDS = 30;
export const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 3600;
export const REFRESH_TOKEN_LIFETIME_SECONDS = 86400 * 30;
/** How far an `iat` may sit from this node's clock. */
export const CLOCK_SKEW_SECONDS = 60;

/** A credential whose group signature this node has checked. */
export interface VerifiedCredential extends CredentialClaims {
  aud?: string;
  iat: number;
  exp: number;
}

export function checkLifetime(what: string, iat: number, exp: number, maxSeconds: number): void {
  const lifetime = exp - iat;
  if (lifetime <= 0 || lifetime > maxSeconds) {
    throw new Error(`${what} lifetime ${lifetime}s out of range: exp - iat must be 1..${maxSeconds}`);
  }
}

export function checkFreshness(what: string, iat: number, now: number): void {
  if (Math.abs(now - iat) > CLOCK_SKEW_SECONDS) {
    throw new Error(`${what} iat is outside the ±${CLOCK_SKEW_SECONDS}s window`);
  }
}

export function verifyAssertion(token: string, identity: NodeIdentity, now: number): VerifiedCredential {
  const claims = verifyCredential(token, identity, now, "assertion", ASSERTION_TYP);
  if (claims.aud !== identity.issuer) {
    throw new Error(`rejected assertion: aud mismatch, expected ${identity.issuer}`);
  }
  checkLifetime("assertion", claims.iat, claims.exp, MAX_ASSERTION_LIFETIME_SECONDS);
  return claims;
}

export function verifyRefreshToken(token: string, identity: NodeIdentity, now: number): VerifiedCredential {
  const claims = verifyCredential(token, identity, now, "refresh_token", REFRESH_TOKEN_TYP);
  checkLifetime("refresh_token", claims.iat, claims.exp, REFRESH_TOKEN_LIFETIME_SECONDS);
  return claims;
}

/** The group signature, then `checkedClaimsOf`; each reason is prefixed with `rejected <what>:`. */
function verifyCredential(token: string, identity: NodeIdentity, now: number, what: string, typ: string): VerifiedCredential {
  try {
    return checkedClaimsOf(verifyJwt(token, identity.groupPublicKey), identity, now, typ);
  } catch (err) {
    throw new Error(`rejected ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `typ`, `iat`/`exp` present and not yet expired, `iss`, and the identity fields present. */
function checkedClaimsOf({ header, payload }: Jwt, identity: NodeIdentity, now: number, typ: string): VerifiedCredential {
  if (header.typ !== typ) {
    throw new Error(`typ ${String(header.typ)} is not ${typ}`);
  }
  const { iat, exp } = payload;
  if (typeof iat !== "number" || typeof exp !== "number") {
    throw new Error("iat or exp is missing");
  }
  if (exp < now) {
    throw new Error(`expired (exp: ${exp}, now: ${now})`);
  }
  if (payload.iss !== identity.issuer) {
    throw new Error(`iss mismatch, expected ${identity.issuer}`);
  }

  const claims: VerifiedCredential = { ...credentialClaimsOf(payload), iat, exp };
  if (typeof payload.aud === "string") claims.aud = payload.aud;
  return claims;
}
