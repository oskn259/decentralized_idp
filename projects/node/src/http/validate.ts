import { Context } from "hono";
import { DemoLog } from "./demo-log.js";

/**
 * The glue between `@hono/zod-validator` and this API's `400 { error }`. The request
 * schemas themselves are the sdk's (`@decentralized-idp/sdk/node-api`).
 */

/** What a validator hook is handed on failure: the issues, whatever the exact error class. */
interface Issues {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}

/** The first problem, as `body.field: message`. */
export function problemOf(error: Issues): string {
  const issue = error.issues[0];
  return `${["body", ...issue.path].join(".")} ${issue.message}`;
}

type Validated = { success: true } | { success: false; error: Issues };

/** Hono's validator answers a malformed JSON body in its own shape; this keeps the API's `{ error }`. */
export async function requireJson(c: Context, next: () => Promise<void>): Promise<Response | void> {
  try {
    await c.req.json();
  } catch {
    return c.json({ error: "Request body is not valid JSON" }, 400);
  }
  await next();
}

/** Validator hook answering `400 { error }`. */
export function badRequest(demo: DemoLog, event: string) {
  return (result: Validated, c: Context): Response | undefined => {
    if (result.success) return undefined;
    const problem = problemOf(result.error);
    demo.reject(event, problem);
    return c.json({ error: problem }, 400);
  };
}
