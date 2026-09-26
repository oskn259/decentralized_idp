import http from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { Context, Hono } from "hono";
import * as oauth from "openid-client";
import type { OAuthClient, Session } from "../oauth.js";
import { claimsPage, errorPage, homePage } from "./pages.js";

/**
 * Routes:
 *   GET  /          a "Sign in" link
 *   GET  /login     302 to the authorization endpoint
 *   GET  /callback  ?code&state: exchange the code for tokens, show the claims
 *   POST /refresh   session=<id>: exchange the stored refresh token, show the claims
 */
export function createRpApp(client: OAuthClient): Hono {
  const app = new Hono();
  // Keyed by `state` until the callback spends it, then by a fresh id the refresh form carries.
  const sessions = new Map<string, Session>();

  /** Looks a session up and forgets it: every key is spent once. */
  function take(key: string | undefined): Session | undefined {
    if (!key) return undefined;
    const session = sessions.get(key);
    sessions.delete(key);
    return session;
  }

  /** Shows the claims of a fresh token set and remembers the refresh token under a new id. */
  async function signedIn(tokens: oauth.TokenEndpointResponse, session: Session, c: Context): Promise<Response> {
    const claims = await client.verify(tokens.access_token, session);
    const id = oauth.randomState();
    sessions.set(id, { ...session, refreshToken: tokens.refresh_token });
    return c.html(claimsPage(claims, id));
  }

  app.onError((err, c) => {
    if (err instanceof oauth.ResponseBodyError || err instanceof oauth.AuthorizationResponseError) {
      return c.html(errorPage(err.error, err.error_description), 400);
    }
    console.error("[rp] unhandled request error:", err);
    return c.text("Internal server error", 500);
  });

  app.get("/", (c) => c.html(homePage()));

  app.get("/login", async (c) => {
    const { url, state, session } = await client.startLogin();
    sessions.set(state, session);
    return c.redirect(url.href, 302);
  });

  app.get("/callback", async (c) => {
    const state = c.req.query("state");
    const session = take(state);
    if (!session) {
      return c.text("unknown state", 400);
    }
    return signedIn(await client.exchangeCode(c.req.url, state!, session), session, c);
  });

  app.post("/refresh", async (c) => {
    const form = await c.req.parseBody();
    const session = take(typeof form.session === "string" ? form.session : undefined);
    if (!session?.refreshToken) {
      return c.text("unknown session", 400);
    }
    return signedIn(await client.refresh(session), session, c);
  });

  return app;
}

/** Built without binding a port, so callers decide where it listens. */
export function createRpServer(client: OAuthClient): http.Server {
  return createAdaptorServer({ fetch: createRpApp(client).fetch }) as http.Server;
}
