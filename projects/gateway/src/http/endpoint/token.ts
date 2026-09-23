import { Context } from "hono";
import { z } from "zod";
import { Gateway } from "../../domain/usecase/gateway.js";
import { OAuthError, issueTokens } from "../../domain/usecase/issue-tokens.js";
import { DemoLog, excludedPhrase, shortValue } from "../demo-log.js";

/**
 * `POST /token` form (RFC 6749), `application/x-www-form-urlencoded`:
 *   grant_type=authorization_code&code=<assertion>
 *   grant_type=refresh_token&refresh_token=<jwt>
 */
export const tokenForm = z
  .object({
    grant_type: z.enum(["authorization_code", "refresh_token"], "must be authorization_code or refresh_token"),
    code: z.string().optional(),
    refresh_token: z.string().optional(),
  })
  .refine((f) => (f.grant_type === "authorization_code" ? !!f.code : !!f.refresh_token), {
    message: "code (authorization_code) or refresh_token (refresh_token) is required",
  });

/**
 * The DPoP proof (RFC 9449) travels in the `DPoP` header.
 *
 * 200: { access_token, token_type: "DPoP", expires_in, refresh_token, scope }
 * 400: { error, error_description } with an RFC 6749 / RFC 9449 error code.
 */
export async function tokenEndpoint(gateway: Gateway, form: z.infer<typeof tokenForm>, c: Context, demo: DemoLog): Promise<Response> {
  const grant = form.grant_type;
  // The schema's refine guarantees the field for this grant is present.
  const credential = (grant === "authorization_code" ? form.code : form.refresh_token) as string;
  // RFC 6749 §5.1: token responses must not be cached.
  c.header("Cache-Control", "no-store");

  try {
    const proof = c.req.header("DPoP");
    if (!proof) {
      throw new OAuthError("invalid_dpop_proof", "a DPoP header is required");
    }
    const issued = await issueTokens(gateway, { grant, credential, dpopProof: proof });

    const authz = grant === "authorization_code";
    demo.event(
      "token",
      `grant=${authz ? "authz" : "refresh"}  ← ${authz ? "code(assertion)" : "refresh_token"} ${shortValue(credential)} + DPoP ✓` +
        `${excludedPhrase(issued.excluded)}  → 2×/commit ×${issued.participants.length} → /sign → ` +
        `access_token ${issued.accessToken.slice(0, 16)} (cnf.jkt=${shortValue(issued.cnfJkt)}) + refresh_token`
    );
    return c.json({
      access_token: issued.accessToken,
      token_type: "DPoP",
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: issued.scope,
    });
  } catch (err) {
    const code = err instanceof OAuthError ? err.code : "invalid_request";
    const description = err instanceof Error ? err.message : String(err);
    demo.reject("token", `${code}: ${description}`);
    return c.json({ error: code, error_description: description }, 400);
  }
}
