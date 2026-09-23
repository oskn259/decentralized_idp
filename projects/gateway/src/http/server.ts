import http from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Gateway } from "../domain/usecase/gateway.js";
import { DemoLog } from "./demo-log.js";
import { authorizeEndpoint, authorizeQuery, authorizeRefusal } from "./endpoint/authorize.js";
import { healthEndpoint } from "./endpoint/health.js";
import { jwksEndpoint, metadataEndpoint } from "./endpoint/metadata.js";
import { signOnBody, signOnEndpoint } from "./endpoint/sign-on.js";
import { tokenEndpoint, tokenForm } from "./endpoint/token.js";
import { uiEndpoint } from "./endpoint/ui.js";
import { badRequest, invalidRequest, requireJson } from "./validate.js";

export interface ServerOptions {
  /** Directory holding the built login UI: `index.html` and `assets/`. */
  loginDist: string;
  /** The relying party's origin, the one allowed to call `/token` and `/jwks.json` cross-origin. */
  rpOrigin: string;
}

/** Every route, with its schema validated before the endpoint runs. */
export function createGatewayApp(gateway: Gateway, demo: DemoLog, options: ServerOptions): Hono {
  const app = new Hono();

  app.notFound((c) => c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404));
  app.onError((err, c) => {
    console.error("[gateway] unhandled request error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/health", (c) => healthEndpoint(gateway, c));
  app.get("/.well-known/oauth-authorization-server", (c) => metadataEndpoint(gateway.group, c, demo));
  app.use("/jwks.json", cors({ origin: options.rpOrigin }));
  app.get("/jwks.json", (c) => jwksEndpoint(gateway.group, c, demo));
  app.get("/authorize", zValidator("query", authorizeQuery, authorizeRefusal(demo)), (c) =>
    authorizeEndpoint(c.req.valid("query"), c, demo)
  );
  app.post("/api/pasta/sign-on", requireJson, zValidator("json", signOnBody, badRequest(demo, "sign-on")), (c) =>
    signOnEndpoint(gateway, c.req.valid("json"), c, demo)
  );
  app.use("/token", cors({ origin: options.rpOrigin, allowHeaders: ["DPoP", "Content-Type"] }));
  app.post("/token", zValidator("form", tokenForm, invalidRequest(demo, "token")), (c) =>
    tokenEndpoint(gateway, c.req.valid("form"), c, demo)
  );

  const ui = uiEndpoint(options.loginDist);
  app.get("/", ui);
  app.get("/login", ui);
  app.get("/assets/*", ui);

  return app;
}

/** Built without binding a port, so callers (and tests) decide where it listens. */
export function createGatewayServer(gateway: Gateway, demo: DemoLog, options: ServerOptions): http.Server {
  return createAdaptorServer({ fetch: createGatewayApp(gateway, demo, options).fetch }) as http.Server;
}
