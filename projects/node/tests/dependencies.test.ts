import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Which layer may import from which. Every arrow points down, so the effect of a change is
 * bounded by this table. `@decentralized-idp/sdk` is a package, not a layer: any layer may
 * import it. The README's 依存の向き section is this table in prose.
 */
const ALLOWED: Record<string, string[]> = {
  main: ["http", "http/leaf", "infra"],
  http: ["http/endpoint", "http/leaf", "domain/usecase", "domain/repository"],
  "http/endpoint": ["http/leaf", "domain/usecase"],
  "http/leaf": [],
  infra: ["domain/usecase", "domain/entity", "domain/repository", "domain/infra", "domain/value"],
  "domain/usecase": ["domain/service", "domain/repository", "domain/infra", "domain/value"],
  "domain/service": ["domain/value"],
  "domain/entity": [],
  "domain/repository": ["domain/entity"],
  "domain/infra": [],
  "domain/value": [],
};

/** `validate.ts` and `demo-log.ts` are the leaves of `http` that endpoints build on. */
const HTTP_LEAVES = new Set(["demo-log", "validate"]);

const SRC = path.resolve(__dirname, "../src");

function layerOf(file: string): string {
  const rel = path.relative(SRC, file).replace(/\.ts$/, "");
  const [top, second] = rel.split(path.sep);
  if (top === "main") return "main";
  if (top === "domain") return `domain/${second}`;
  if (top === "http") return second === "endpoint" ? "http/endpoint" : HTTP_LEAVES.has(second) ? "http/leaf" : "http";
  return top;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

function localImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  return [...text.matchAll(/from "(\.[^"]+)"/g)].map((m) => path.resolve(path.dirname(file), m[1].replace(/\.js$/, ".ts")));
}

describe("dependency direction", () => {
  const files = sourceFiles(SRC);

  it("covers every source file with a known layer", () => {
    for (const file of files) {
      expect(ALLOWED, path.relative(SRC, file)).toHaveProperty(layerOf(file));
    }
  });

  it.each(files.map((f) => [path.relative(SRC, f), f]))("%s imports only from layers below it", (_, file) => {
    const from = layerOf(file);
    for (const target of localImports(file)) {
      const to = layerOf(target);
      if (to === from) continue;
      expect(ALLOWED[from], `${from} → ${to} (${path.relative(SRC, target)})`).toContain(to);
    }
  });
});
