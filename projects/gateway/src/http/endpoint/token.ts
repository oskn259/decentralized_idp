import { decodePaymentResponseHeader } from "@x402/core/http";
import { Context } from "hono";
import { z } from "zod";
import { admit, charge } from "@decentralized-idp/sdk/x402";
import { authenticateClient } from "../../domain/usecase/client-auth.js";
import { Gateway } from "../../domain/usecase/gateway.js";
import { issueTokens } from "../../domain/usecase/issue-tokens.js";
import { OAuthError } from "../../domain/usecase/oauth-error.js";
import { tokenEndpointUrl } from "../../domain/value/group.js";
import { DemoLog, excludedPhrase, shortValue } from "../demo-log.js";

const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * `POST /token` form (RFC 6749), `application/x-www-form-urlencoded`, with the client
 * authenticated by `private_key_jwt` (RFC 7523 §2.2):
 *   grant_type=authorization_code&code=<assertion>&client_assertion_type=<JWT_BEARER>&client_assertion=<jwt>
 *   grant_type=refresh_token&refresh_token=<jwt>&client_assertion_type=<JWT_BEARER>&client_assertion=<jwt>
 */
export const tokenForm = z
  .object({
    grant_type: z.enum(["authorization_code", "refresh_token"], "must be authorization_code or refresh_token"),
    code: z.string().optional(),
    refresh_token: z.string().optional(),
    client_id: z.string().optional(),
    client_assertion_type: z.literal(JWT_BEARER, `must be ${JWT_BEARER}`),
    client_assertion: z.string("is required").min(1, "is required"),
  })
  .refine((f) => (f.grant_type === "authorization_code" ? !!f.code : !!f.refresh_token), {
    message: "code (authorization_code) or refresh_token (refresh_token) is required",
  });

/** RFC 6749 §5.2: missing or malformed client authentication is `invalid_client`. */
export function tokenFormError(field: string): string {
  return field.startsWith("client_assertion") ? "invalid_client" : "invalid_request";
}

/**
 * The DPoP proof (RFC 9449) travels in the `DPoP` header. Each issued token set costs the
 * client one x402 credit; a refused request costs nothing.
 *
 * 200: { access_token, token_type: "DPoP", expires_in, refresh_token, scope }
 * 400: { error, error_description } with an RFC 6749 / RFC 9449 error code.
 * 402: { error: "payment_required", error_description } with `PAYMENT-REQUIRED`: no credit left.
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
    const clientId = authenticateClient(gateway, form.client_assertion, form.client_id);
    const { terms, credits, settler } = gateway.billing;
    const admission = await admit(credits, settler, terms, clientId, tokenEndpointUrl(gateway.group), c.req.header("PAYMENT-SIGNATURE"));
    if (!admission.paid) {
      demo.reject("token", `payment_required: ${admission.reason}`);
      c.header("PAYMENT-REQUIRED", admission.paymentRequired);
      return c.json({ error: "payment_required", error_description: admission.reason }, 402);
    }
    if (admission.paymentResponse !== undefined) {
      // Settled on chain: the credits are the client's even if this request is refused below.
      c.header("PAYMENT-RESPONSE", admission.paymentResponse);
      const { transaction } = decodePaymentResponseHeader(admission.paymentResponse);
      demo.event("pay", `from=${clientId} +${terms.batch} credits (settled ${shortValue(transaction)})`);
    }

    const issued = await issueTokens(gateway, { grant, credential, dpopProof: proof, clientId });
    charge(credits, clientId);

    const authz = grant === "authorization_code";
    demo.event(
      "token",
      `grant=${authz ? "authz" : "refresh"} client=${issued.clientId}  ← ${authz ? "code(assertion)" : "refresh_token"} ${shortValue(credential)} + DPoP ✓` +
        `${excludedPhrase(issued.excluded)}  → 2×/commit ×${issued.participants.length} → /sign → ` +
        `access_token ${issued.accessToken.slice(0, 16)} (cnf.jkt=${shortValue(issued.cnfJkt)}) + refresh_token credits=${credits.balance(clientId)}`
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
