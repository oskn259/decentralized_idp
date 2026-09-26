import http from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { Context, Hono } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { JWTPayload, createRemoteJWKSet, jwtVerify } from "jose";
import * as oauth from "openid-client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

/**
 * A relying party built from ordinary OAuth client libraries only: `openid-client` for the
 * authorization code flow with DPoP (RFC 9449) and private_key_jwt client authentication
 * (RFC 7523), `jose` to verify the access token against the gateway's JWKS, and the x402
 * fetch wrapper to pay for tokens. Nothing here knows about PASTA, FROST or the nodes.
 */

export interface RpOptions {
  /** The gateway as the browser sees it: the OAuth issuer. */
  gatewayUrl: string;
  /** This relying party's own public URL: the base of `redirect_uri`. */
  rpUrl: string;
  clientId: string;
  /** Signs the `client_assertion` that authenticates this client at the token endpoint (private_key_jwt). */
  clientKey: { key: CryptoKey; kid?: string };
  /** Pays the gateway's 402s over x402: USDC on `network`, signed by this key. */
  wallet: { privateKey: `0x${string}`; network: `${string}:${string}` };
  scope: string;
}

/** One sign-in. Keyed by `state` until the callback spends it, then by a fresh id the signed-in page's refresh form carries. */
interface Session {
  dpop: oauth.DPoPHandle;
  jkt: string;
  refreshToken?: string;
}

/**
 * Routes:
 *   GET  /          a "Sign in" link
 *   GET  /login     new state + DPoP key, 302 to the gateway's authorization endpoint
 *   GET  /callback  ?code&state: exchange the code for tokens, show the claims
 *   POST /refresh   session=<id>: exchange the stored refresh token, show the claims
 */
export async function createRpApp(options: RpOptions): Promise<Hono> {
  // RFC 8414 metadata. `allowInsecureRequests` only matters for the plain-http demo issuer.
  const config = await oauth.discovery(new URL(options.gatewayUrl), options.clientId, undefined, oauth.PrivateKeyJwt(options.clientKey), {
    algorithm: "oauth2",
    execute: options.gatewayUrl.startsWith("http:") ? [oauth.allowInsecureRequests] : [],
  });
  // The token endpoint is paid: a 402 is answered by paying for a batch of requests, then retried.
  const payer = new x402Client().register(options.wallet.network, new ExactEvmScheme(privateKeyToAccount(options.wallet.privateKey)));
  const fetchWithPayment = wrapFetchWithPayment(fetch, payer);
  config[oauth.customFetch] = (url, init) => fetchWithPayment(url, init as RequestInit);
  const jwks = createRemoteJWKSet(new URL(config.serverMetadata().jwks_uri!));
  const redirectUri = `${options.rpUrl}/callback`;

  const app = new Hono();
  const sessions = new Map<string, Session>();

  /** Looks a session up and forgets it: every key is spent once. */
  function take(key: string | undefined): Session | undefined {
    if (!key) return undefined;
    const session = sessions.get(key);
    sessions.delete(key);
    return session;
  }

  /** Verifies the access token as any resource server would, plus the DPoP binding to this session's key. */
  async function verify(accessToken: string, session: Session): Promise<JWTPayload> {
    const { payload } = await jwtVerify(accessToken, jwks, { issuer: options.gatewayUrl, audience: options.clientId, typ: "at+jwt" });
    if ((payload.cnf as { jkt?: string } | undefined)?.jkt !== session.jkt) {
      throw new Error("cnf.jkt does not match this session's DPoP key");
    }
    return payload;
  }

  /** Shows the claims of a fresh token set and remembers the refresh token under a new id. */
  async function signedIn(tokens: oauth.TokenEndpointResponse, session: Session, c: Context): Promise<Response> {
    const claims = await verify(tokens.access_token, session);
    const id = oauth.randomState();
    sessions.set(id, { ...session, refreshToken: tokens.refresh_token });
    return c.html(claimsPage(claims, id));
  }

  app.onError((err, c) => {
    // The gateway's OAuth refusal, when that is what happened; otherwise a plain failure.
    if (err instanceof oauth.ResponseBodyError) {
      return c.html(page(html`<p>${err.error}: ${err.error_description ?? ""}</p>`), 400);
    }
    if (err instanceof oauth.AuthorizationResponseError) {
      return c.html(page(html`<p>${err.error}: ${err.error_description ?? ""}</p>`), 400);
    }
    console.error("[rp] unhandled request error:", err);
    return c.text("Internal server error", 500);
  });

  app.get("/", (c) => c.html(page(html`<p><a href="/login">Sign in</a></p>`)));

  app.get("/login", async (c) => {
    const dpop = oauth.getDPoPHandle(config, await oauth.randomDPoPKeyPair("EdDSA"));
    const jkt = await dpop.calculateThumbprint();
    const state = oauth.randomState();
    sessions.set(state, { dpop, jkt });
    const url = oauth.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: options.scope, state, dpop_jkt: jkt });
    return c.redirect(url.href, 302);
  });

  app.get("/callback", async (c) => {
    const session = take(c.req.query("state"));
    if (!session) {
      return c.text("unknown state", 400);
    }
    // The library checks `state`, reads `code` (or the gateway's `error`) off the URL, and
    // posts the code with a DPoP proof to the token endpoint.
    const callbackUrl = new URL(c.req.url);
    callbackUrl.protocol = new URL(redirectUri).protocol;
    callbackUrl.host = new URL(redirectUri).host;
    const tokens = await oauth.authorizationCodeGrant(config, callbackUrl, { expectedState: c.req.query("state") }, undefined, { DPoP: session.dpop });
    return signedIn(tokens, session, c);
  });

  app.post("/refresh", async (c) => {
    const form = await c.req.parseBody();
    const session = take(typeof form.session === "string" ? form.session : undefined);
    if (!session?.refreshToken) {
      return c.text("unknown session", 400);
    }
    const tokens = await oauth.refreshTokenGrant(config, session.refreshToken, undefined, { DPoP: session.dpop });
    return signedIn(tokens, session, c);
  });

  return app;
}

/** Built without binding a port, so callers (and tests) decide where it listens. */
export async function createRpServer(options: RpOptions): Promise<http.Server> {
  const app = await createRpApp(options);
  return createAdaptorServer({ fetch: app.fetch }) as http.Server;
}

function claimsPage(claims: JWTPayload, sessionId: string) {
  return page(html`<dl>
      <dt>sub</dt><dd>${String(claims.sub)}</dd>
      <dt>scope</dt><dd>${String(claims.scope)}</dd>
      <dt>exp</dt><dd>${String(claims.exp)}</dd>
    </dl>
    <form method="post" action="/refresh"><input type="hidden" name="session" value="${sessionId}" /><button>Refresh</button></form>`);
}

function page(body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8" /><title>rp</title></head>
      <body><h1>Relying party</h1>${body}</body>
    </html>`;
}
