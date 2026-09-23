import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { Context } from "hono";
import { Group, tokenEndpointUrl } from "../../domain/value/group.js";
import { DemoLog } from "../demo-log.js";

/** `GET /.well-known/openid-configuration`: OAuth 2.0 authorization code + DPoP, no id_token. */
export function metadataEndpoint(group: Group, c: Context, demo: DemoLog): Response {
  demo.event("discovery", "public only");
  return c.json({
    issuer: group.issuer,
    authorization_endpoint: `${group.issuer}/authorize`,
    token_endpoint: tokenEndpointUrl(group),
    jwks_uri: `${group.issuer}/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    dpop_signing_alg_values_supported: ["EdDSA"],
    scopes_supported: ["openid", "profile", "email"],
  });
}

/** `GET /jwks.json`: the one Ed25519 group key, as a JWK Set (RFC 8037). */
export function jwksEndpoint(group: Group, c: Context, demo: DemoLog): Response {
  demo.event("jwks", "public only");
  return c.json({
    keys: [{ kty: "OKP", crv: "Ed25519", x: base64UrlEncode(group.groupPublicKey), kid: group.keyId, use: "sig", alg: "EdDSA" }],
  });
}
