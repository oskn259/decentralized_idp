import http from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { Context, Hono } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DPoPKeyPair, calculateJwkThumbprint, exportDPoPJwk, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { requestToken } from "../token.js";
import { verifyAccessToken } from "../verify.js";

export interface RpOptions {
  /** The gateway as the browser sees it: where `/login` redirects to, and the issuer named in the DPoP proof. */
  gatewayUrl: string;
  /** This relying party's own public URL: the base of `redirect_uri`. */
  rpUrl: string;
  clientId: string;
  scope: string;
}

/**
 * One sign-in. Keyed by `state` until the callback spends it, then by a fresh id that the
 * signed-in page's refresh form carries. Every key is used once.
 */
interface Session {
  dpop: DPoPKeyPair;
  jkt: string;
  refreshToken?: string;
}

/**
 * Routes:
 *   GET  /          a "Sign in" link
 *   GET  /login     new state + DPoP key, 302 to the gateway's /authorize
 *   GET  /callback  ?code=<assertion>&state: exchange the code for tokens, show the claims
 *   POST /refresh   session=<id>: exchange the stored refresh token, show the claims
 */
export function createRpApp(options: RpOptions): Hono {
  const app = new Hono();
  const sessions = new Map<string, Session>();

  /** Looks a session up and forgets it: every key is spent once. */
  function take(key: string | undefined): Session | undefined {
    if (!key) return undefined;
    const session = sessions.get(key);
    sessions.delete(key);
    return session;
  }

  /** `POST /token`, then the claims page (or the gateway's OAuth error with its status). */
  async function exchange(session: Session, grant: "authorization_code" | "refresh_token", credential: string, c: Context): Promise<Response> {
    const res = await requestToken({ gatewayUrl: options.gatewayUrl, issuer: options.gatewayUrl, dpop: session.dpop, grant, credential });
    if (!("access_token" in res.body)) {
      return c.html(page(html`<p>${res.body.error}: ${res.body.error_description}</p>`), res.status as ContentfulStatusCode);
    }
    const claims = await verifyAccessToken(options.gatewayUrl, res.body.access_token, { aud: options.clientId, jkt: session.jkt });
    const id = crypto.randomUUID();
    sessions.set(id, { ...session, refreshToken: res.body.refresh_token });
    return c.html(claimsPage(claims, id));
  }

  app.onError((err, c) => {
    console.error("[rp] unhandled request error:", err);
    return c.text("Internal server error", 500);
  });

  app.get("/", (c) => c.html(page(html`<p><a href="/login">Sign in</a></p>`)));

  app.get("/login", (c) => {
    const dpop = generateDPoPKeyPair();
    const jkt = calculateJwkThumbprint(exportDPoPJwk(dpop.publicKey));
    const state = crypto.randomUUID();
    sessions.set(state, { dpop, jkt });
    return c.redirect(authorizeUrl(options, state, jkt), 302);
  });

  app.get("/callback", (c) => {
    const session = take(c.req.query("state"));
    if (!session) {
      return c.text("unknown state", 400);
    }
    return exchange(session, "authorization_code", c.req.query("code") ?? "", c);
  });

  app.post("/refresh", async (c) => {
    const form = await c.req.parseBody();
    const session = take(typeof form.session === "string" ? form.session : undefined);
    if (!session?.refreshToken) {
      return c.text("unknown session", 400);
    }
    return exchange(session, "refresh_token", session.refreshToken, c);
  });

  return app;
}

/** Built without binding a port, so callers (and tests) decide where it listens. */
export function createRpServer(options: RpOptions): http.Server {
  return createAdaptorServer({ fetch: createRpApp(options).fetch }) as http.Server;
}

/** The OAuth authorization request, with `dpop_jkt` so the tokens bind to this sign-in's key. */
function authorizeUrl(options: RpOptions, state: string, jkt: string): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: `${options.rpUrl}/callback`,
    scope: options.scope,
    state,
    dpop_jkt: jkt,
  });
  return `${options.gatewayUrl}/authorize?${query}`;
}

function claimsPage(claims: Record<string, unknown>, sessionId: string) {
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
