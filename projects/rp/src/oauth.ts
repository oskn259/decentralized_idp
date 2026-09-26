import { JWTPayload, createRemoteJWKSet, jwtVerify } from "jose";
import * as oauth from "openid-client";

/**
 * An ordinary OAuth 2.0 client: the authorization code flow with DPoP and private_key_jwt on
 * `openid-client`, and access tokens verified with `jose`. Nothing here is specific to DAuth.
 */

export interface OAuthOptions {
  /** The authorization server; discovery starts here. */
  issuer: string;
  clientId: string;
  /** Signs the `client_assertion` that authenticates this client at the token endpoint. */
  clientKey: { key: CryptoKey; kid?: string };
  redirectUri: string;
  scope: string;
}

/** One sign-in: the DPoP key its tokens are bound to, and the refresh token once there is one. */
export interface Session {
  dpop: oauth.DPoPHandle;
  jkt: string;
  refreshToken?: string;
}

export type OAuthClient = Awaited<ReturnType<typeof createOAuthClient>>;

export async function createOAuthClient(options: OAuthOptions) {
  // `allowInsecureRequests` only for a plain-http issuer, as in the local demo.
  const config = await oauth.discovery(new URL(options.issuer), options.clientId, undefined, oauth.PrivateKeyJwt(options.clientKey), {
    algorithm: "oauth2",
    execute: options.issuer.startsWith("http:") ? [oauth.allowInsecureRequests] : [],
  });
  const jwks = createRemoteJWKSet(new URL(config.serverMetadata().jwks_uri!));

  /** A new DPoP key and state, and the authorization URL to send the browser to. */
  async function startLogin(): Promise<{ url: URL; state: string; session: Session }> {
    const dpop = oauth.getDPoPHandle(config, await oauth.randomDPoPKeyPair("EdDSA"));
    const jkt = await dpop.calculateThumbprint();
    const state = oauth.randomState();
    const url = oauth.buildAuthorizationUrl(config, { redirect_uri: options.redirectUri, scope: options.scope, state, dpop_jkt: jkt });
    return { url, state, session: { dpop, jkt } };
  }

  /** Trades the code on the callback URL for tokens. The callback's query is read against `redirectUri`, whatever host the request came in on. */
  function exchangeCode(callbackUrl: string, state: string, session: Session): Promise<oauth.TokenEndpointResponse> {
    const url = new URL(options.redirectUri);
    url.search = new URL(callbackUrl).search;
    return oauth.authorizationCodeGrant(config, url, { expectedState: state }, undefined, { DPoP: session.dpop });
  }

  function refresh(session: Session): Promise<oauth.TokenEndpointResponse> {
    return oauth.refreshTokenGrant(config, session.refreshToken!, undefined, { DPoP: session.dpop });
  }

  /** Verifies the access token as any resource server would, plus its DPoP binding to this session's key. */
  async function verify(accessToken: string, session: Session): Promise<JWTPayload> {
    const { payload } = await jwtVerify(accessToken, jwks, { issuer: options.issuer, audience: options.clientId, typ: "at+jwt" });
    if ((payload.cnf as { jkt?: string } | undefined)?.jkt !== session.jkt) {
      throw new Error("cnf.jkt does not match this session's DPoP key");
    }
    return payload;
  }

  return { config, startLogin, exchangeCode, refresh, verify };
}
