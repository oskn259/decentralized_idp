/** The login page: `index.html` for `/` and `/login`, and the build's `assets/*`. */
import fs from "node:fs/promises";
import path from "node:path";
import { Context } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function uiEndpoint(loginDist: string) {
  const root = path.resolve(loginDist);
  return async (c: Context): Promise<Response> => {
    const requested = c.req.path === "/" || c.req.path === "/login" ? "index.html" : c.req.path.slice(1);
    const file = path.resolve(root, requested);
    if (!file.startsWith(root + path.sep)) {
      return c.notFound();
    }
    try {
      const body = await fs.readFile(file);
      return c.body(body, 200, { "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" });
    } catch {
      return c.notFound();
    }
  };
}
