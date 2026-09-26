import { Context } from "hono";
import { AlreadyRegisteredError } from "../domain/repository/user-repository.js";
import { DemoLog } from "./demo-log.js";

/**
 * Answers an endpoint's result as JSON. A refusal it throws becomes `{ error }`, noted in the
 * demo log: 409 for a taken username or sub, 400 for everything else.
 */
export function answer(c: Context, demo: DemoLog, event: string, run: () => unknown): Response {
  try {
    return c.json(run());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    demo.reject(event, message);
    return c.json({ error: message }, err instanceof AlreadyRegisteredError ? 409 : 400);
  }
}
