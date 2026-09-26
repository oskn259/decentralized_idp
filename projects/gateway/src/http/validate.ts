/** Request schemas are Zod; these are the refusal hooks every endpoint shares. */
import { Context } from "hono";
import { DemoLog } from "./demo-log.js";

/** What a validator hook is handed on failure: the issues, whatever the exact error class. */
interface Issues {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}

/** The first problem, as `field: message`. */
export function problemOf(error: Issues): string {
  const issue = error.issues[0];
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
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

/** Validator hook answering `400 { error, error_description }` (OAuth endpoints); `errorOf` picks the code from the failing field. */
export function oauthRefusal(demo: DemoLog, event: string, errorOf: (field: string) => string) {
  return (result: Validated, c: Context): Response | undefined => {
    if (result.success) return undefined;
    const problem = problemOf(result.error);
    const error = errorOf(result.error.issues[0].path.join("."));
    demo.reject(event, `${error}: ${problem}`);
    c.header("Cache-Control", "no-store");
    return c.json({ error, error_description: problem }, 400);
  };
}

/** Validator hook answering `400 { error }` (the login page's JSON API). */
export function badRequest(demo: DemoLog, event: string) {
  return (result: Validated, c: Context): Response | undefined => {
    if (result.success) return undefined;
    const problem = problemOf(result.error);
    demo.reject(event, problem);
    return c.json({ error: problem }, 400);
  };
}
