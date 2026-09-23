import { Context } from "hono";
import { DemoLog } from "./demo-log.js";

/** Answers an endpoint's result as JSON; every refusal it throws becomes `400 { error }`, noted in the demo log. */
export function answer(c: Context, demo: DemoLog, event: string, run: () => unknown): Response {
  try {
    return c.json(run());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    demo.reject(event, message);
    return c.json({ error: message }, 400);
  }
}
