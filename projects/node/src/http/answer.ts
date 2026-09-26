import { Context } from "hono";
import { AlreadyRegisteredError } from "../domain/repository/user-repository.js";
import { DemoLog } from "./demo-log.js";

/**
 * Answers an endpoint's result as JSON, or passes through a `Response` the endpoint built
 * itself (the 402 of `/sign`). A refusal it throws becomes `{ error }`, noted in the demo
 * log: 409 for a taken username or sub, 400 for everything else.
 */
export async function answer(c: Context, demo: DemoLog, event: string, run: () => unknown): Promise<Response> {
  try {
    const result = await run();
    return result instanceof Response ? result : c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    demo.reject(event, message);
    return c.json({ error: message }, err instanceof AlreadyRegisteredError ? 409 : 400);
  }
}
