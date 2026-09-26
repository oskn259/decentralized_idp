import http from "node:http";
import { commitRequest, registerRequest, signOnRequest, signRequest } from "@decentralized-idp/sdk/node-api";
import { createAdaptorServer } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { IdentityNode } from "../domain/usecase/identity-node.js";
import { DemoLog } from "./demo-log.js";
import { commitEndpoint } from "./endpoint/commit.js";
import { health } from "./endpoint/health.js";
import { registerEndpoint } from "./endpoint/register.js";
import { signOnEndpoint } from "./endpoint/sign-on.js";
import { signEndpoint } from "./endpoint/sign.js";
import { answer } from "./answer.js";
import { badRequest, requireJson } from "./validate.js";

/** Every non-200 body is `{ "error": string }`. */
export function createNodeApp(node: IdentityNode, demo: DemoLog): Hono {
  const app = new Hono();

  app.notFound((c) => c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404));
  app.onError((err, c) => {
    console.error("[node] unhandled request error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/health", (c) => c.json(health(node)));
  // The login page, served by the gateway at the issuer origin, calls /register directly.
  app.use("/register", cors({ origin: node.identity.issuer }));
  app.post("/register", requireJson, zValidator("json", registerRequest, badRequest(demo, "register")), (c) =>
    answer(c, demo, "register", () => registerEndpoint(node, c.req.valid("json"), demo))
  );
  app.post("/commit", requireJson, zValidator("json", commitRequest, badRequest(demo, "commit")), (c) =>
    answer(c, demo, "commit", () => commitEndpoint(node, c.req.valid("json"), demo))
  );
  app.post("/sign-on", requireJson, zValidator("json", signOnRequest, badRequest(demo, "sign-on")), (c) =>
    answer(c, demo, "sign-on", () => signOnEndpoint(node, c.req.valid("json"), demo))
  );
  app.post("/sign", requireJson, zValidator("json", signRequest, badRequest(demo, "sign")), (c) =>
    answer(c, demo, "sign", () => signEndpoint(node, c.req.valid("json"), demo))
  );
  return app;
}

/** Built without binding a port, so callers (and tests) decide where it listens. */
export function createNodeServer(node: IdentityNode, demo: DemoLog): http.Server {
  return createAdaptorServer({ fetch: createNodeApp(node, demo).fetch }) as http.Server;
}
