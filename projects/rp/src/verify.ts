import { base64UrlDecode } from "@decentralized-idp/sdk/base64url";
import { decodeJwt, verifyJwt } from "@decentralized-idp/sdk/jwt";

/** One entry of the gateway's `/jwks.json` (RFC 8037 Ed25519 JWK). */
interface Jwk {
  kid: string;
  x: string;
}

/**
 * Checks an access token the way any relying party would: the signature against the key
 * the gateway publishes under the token's `kid`, `aud` against our client_id, and `cnf.jkt`
 * against the DPoP key we hold. Throws when any of it fails.
 */
export async function verifyAccessToken(gatewayUrl: string, token: string, expected: { aud: string; jkt: string }): Promise<Record<string, unknown>> {
  const res = await fetch(`${gatewayUrl}/jwks.json`);
  const jwks = (await res.json()) as { keys: Jwk[] };
  const kid = decodeJwt(token).header.kid;
  const key = jwks.keys.find((k) => k.kid === kid);
  if (!key) {
    throw new Error(`no JWK for kid ${String(kid)}`);
  }
  const { payload } = verifyJwt(token, base64UrlDecode(key.x));
  if (payload.aud !== expected.aud) {
    throw new Error(`aud mismatch: expected ${expected.aud}, got ${String(payload.aud)}`);
  }
  if ((payload.cnf as { jkt?: string } | undefined)?.jkt !== expected.jkt) {
    throw new Error("cnf.jkt does not match this session's DPoP key");
  }
  return payload;
}
