import { Context } from "hono";
import { z } from "zod";
import { Gateway } from "../../domain/usecase/gateway.js";
import { DemoLog, shortValue } from "../demo-log.js";
import { problemOf } from "../validate.js";

/** `GET /authorize` parameters (response_type=code). `dpop_jkt` is an RFC 7638 thumbprint: SHA-256, base64url, 43 characters. */
export const authorizeQuery = z.object({
  client_id: z.string("is required").min(1, "is required"),
  redirect_uri: z.string("is required").min(1, "is required"),
  response_type: z.literal("code", "must be code"),
  scope: z.string("is required").min(1, "is required"),
  state: z.string().optional(),
  dpop_jkt: z.string("is required").regex(/^[A-Za-z0-9_-]{43}$/, "must be a base64url SHA-256 JWK thumbprint (43 characters)"),
});

/**
 * A refused authorization request. RFC 6749 §4.1.2.1: when the client gave a usable
 * `redirect_uri`, the error goes back to it as query parameters; otherwise a 400.
 */
export function authorizeRefusal(demo: DemoLog) {
  return (result: { success: true } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }, c: Context): Response | undefined => {
    if (result.success) return undefined;
    const problem = problemOf(result.error);
    demo.reject("authorize", problem);
    const redirectUri = c.req.query("redirect_uri");
    if (redirectUri && URL.canParse(redirectUri) && !problem.startsWith("redirect_uri")) {
      const back = new URL(redirectUri);
      back.searchParams.set("error", "invalid_request");
      back.searchParams.set("error_description", problem);
      const state = c.req.query("state");
      if (state) back.searchParams.set("state", state);
      return c.redirect(back.toString(), 302);
    }
    return c.json({ error: "invalid_request", error_description: problem }, 400);
  };
}

/**
 * The gateway keeps no authorize session: it draws the challenge `c` that will be the
 * assertion's nonce and sends the browser on to the login page with everything it needs
 * in the URL. The page mints the assertion and returns to
 * `redirect_uri?code=<assertion>&state=<state>` on its own.
 *
 * An unregistered `client_id` gets a 400 and no redirect: its `redirect_uri` is not trusted.
 */
export function authorizeEndpoint(gateway: Gateway, q: z.infer<typeof authorizeQuery>, c: Context, demo: DemoLog): Response {
  if (!gateway.clients.some((client) => client.clientId === q.client_id)) {
    const problem = `unknown client_id ${q.client_id}`;
    demo.reject("authorize", problem);
    return c.json({ error: "unauthorized_client", error_description: problem }, 400);
  }
  const challenge = crypto.randomUUID();
  const login = new URLSearchParams({
    step: "login",
    c: challenge,
    client_id: q.client_id,
    redirect_uri: q.redirect_uri,
    scope: q.scope,
    state: q.state ?? "",
    dpop_jkt: q.dpop_jkt,
  });

  demo.event(
    "authorize",
    `client_id=${q.client_id} nonce=${challenge} state=${q.state || "-"} dpop_jkt=${shortValue(q.dpop_jkt)}  → redirect /login`
  );
  return c.redirect(`/login?${login}`, 302);
}
