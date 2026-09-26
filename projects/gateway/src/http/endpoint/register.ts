import { nodeId, sealedBox, text } from "@decentralized-idp/sdk/node-api";
import { Context } from "hono";
import { z } from "zod";
import { Gateway } from "../../domain/usecase/gateway.js";
import { UsernameTakenError, register } from "../../domain/usecase/register.js";
import { DemoLog, shortValue } from "../demo-log.js";

/** `POST /api/pasta/register` body, from the login page: one sealed share per node. Bytes are base64url. */
export const registerBody = z.object({
  username: text,
  shares: z.array(z.object({ nodeId, share: sealedBox }), "must be an array"),
});

export async function registerEndpoint(gateway: Gateway, request: z.infer<typeof registerBody>, c: Context, demo: DemoLog): Promise<Response> {
  let sub: string;
  try {
    ({ sub } = await register(gateway, request));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    demo.reject("register", message);
    return c.json({ error: message }, err instanceof UsernameTakenError ? 409 : 400);
  }

  demo.event("register", `user=${request.username} sub=${shortValue(sub)} → /register ×${request.shares.length} sealed (cannot open) ✓`);
  return c.json({ sub });
}
