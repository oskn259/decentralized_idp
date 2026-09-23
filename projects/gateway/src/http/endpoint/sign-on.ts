import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { bytes, text } from "@decentralized-idp/sdk/node-api";
import { Context } from "hono";
import { z } from "zod";
import { Gateway } from "../../domain/usecase/gateway.js";
import { SignOnResponse, signOn } from "../../domain/usecase/sign-on.js";
import { DemoLog, excludedPhrase, shortValue } from "../demo-log.js";

/** `POST /api/pasta/sign-on` body, from the login page. Bytes are base64url. */
export const signOnBody = z.object({
  username: text,
  /** A = r·H1(password) */
  blinded: bytes(32),
  sessionNonce: bytes(),
  cnfJkt: text,
  clientId: text,
  scope: z.string("must be a string").default(""),
  /** The challenge `c` handed out by `/authorize`. */
  nonce: text,
  iat: z.int("must be an integer"),
  exp: z.int("must be an integer"),
});

export async function signOnEndpoint(gateway: Gateway, request: z.infer<typeof signOnBody>, c: Context, demo: DemoLog): Promise<Response> {
  let out: SignOnResponse;
  try {
    out = await signOn(gateway, request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    demo.reject("sign-on", message);
    return c.json({ error: message }, 400);
  }

  const n = out.participants.length;
  demo.event(
    "sign-on",
    `round=${shortValue(out.roundId)} user=${request.username} nonce=${request.nonce}  ` +
      `← A ${shortValue(base64UrlEncode(request.blinded))}  jkt ${shortValue(request.cnfJkt)}  (no pw)`
  );
  demo.more(`round1 (D,E)×${n}${excludedPhrase(out.excluded)} → round2 ← B_i×${n} ct_i×${n} (no h_i, cannot decrypt) → relayed as-is`);
  return c.json({
    commitments: out.commitments.map((k) => ({ nodeId: k.nodeId, D: base64UrlEncode(k.D), E: base64UrlEncode(k.E) })),
    shares: out.shares.map((s) => ({
      nodeId: s.nodeId,
      toprfPartial: base64UrlEncode(s.toprfPartial),
      ct_i: base64UrlEncode(s.ct_i),
      sub: s.sub,
    })),
  });
}
