import { Context } from "hono";
import { z } from "zod";
import { DemoLog, shortValue } from "../demo-log.js";

/** `GET /authorize` parameters (response_type=code). `dpop_jkt` is an RFC 7638 thumbprint: SHA-256, base64url, 43 characters. */
export const authorizeQuery = z.object({
  client_id: z.string("is required").min(1, "is required"),
  redirect_uri: z.string("is required").min(1, "is required"),
  response_type: z.literal("code", "must be code"),
  scope: z.string("is required").refine((s) => s.split(" ").includes("openid"), "must include openid"),
  state: z.string().optional(),
  dpop_jkt: z.string("is required").regex(/^[A-Za-z0-9_-]{43}$/, "must be a base64url SHA-256 JWK thumbprint (43 characters)"),
});

/**
 * The gateway keeps no authorize session: it draws the challenge `c` that will be the
 * assertion's nonce and sends the browser on to the login page with everything it needs
 * in the URL. The page mints the assertion and returns to
 * `redirect_uri?code=<assertion>&state=<state>` on its own.
 */
export function authorizeEndpoint(q: z.infer<typeof authorizeQuery>, c: Context, demo: DemoLog): Response {
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
