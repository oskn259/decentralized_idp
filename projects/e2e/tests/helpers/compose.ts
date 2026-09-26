import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The system as `compose.yaml` runs it: real containers, reached from the host exactly as a
 * person's browser would. Nothing here imports project code; the only contract is the two
 * published ports and what the pages say.
 */

export const GATEWAY_URL = process.env.GW ?? "http://localhost:3000";
export const RP_URL = process.env.RP ?? "http://localhost:3001";
export const SCOPE = "profile";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

function compose(...args: string[]): string {
  const run = spawnSync("docker", ["compose", ...args], { cwd: repoRoot, encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed:\n${run.stderr}`);
  }
  return run.stdout;
}

/** Builds and starts everything, returning once every service reports healthy. */
export function up(): void {
  compose("up", "--build", "--wait");
}

/** Takes one node down. The gateway sees it as unreachable on its next request. */
export function stopNode(id: 1 | 2 | 3): void {
  compose("stop", `node${id}`);
}

/** Brings stopped services back and waits for them to be healthy again. */
export function restore(): void {
  compose("up", "--wait");
}

/** Everything every container has logged so far. */
export function logs(): string {
  return compose("logs", "--no-color");
}
