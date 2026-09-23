import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hexToBytes } from "@decentralized-idp/sdk/hex";
import { verifyJwt } from "@decentralized-idp/sdk/jwt";
import { LiveGateway, startLiveGateway } from "./helpers/live-gateway.js";
import { LiveNode, nodeFixturePath, startLiveNodes, stopLiveNodes } from "./helpers/live-node.js";

/** Runs `cli.ts` as a child process (`tsx`) against three real nodes behind a real gateway. */

const ISSUER = "http://localhost:3000";
const RP_ORIGIN = "http://localhost:5173";

const LOGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX_BIN = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));

let liveNodes: LiveNode[];
let liveGateway: LiveGateway;
let groupPublicKey: Uint8Array;

beforeAll(async () => {
  // The CLI stamps real wall-clock time, so this stack runs on the real clock too.
  const clock = { nowSeconds: () => Math.floor(Date.now() / 1000) };
  liveNodes = await startLiveNodes({ issuer: ISSUER, clock });
  liveGateway = await startLiveGateway({ issuer: ISSUER, clock, rpOrigin: RP_ORIGIN, nodes: liveNodes });
  const group = JSON.parse(fs.readFileSync(nodeFixturePath("group.json"), "utf8")) as { groupPublicKey: string };
  groupPublicKey = hexToBytes(group.groupPublicKey);
});

afterAll(async () => {
  await liveGateway.close();
  await stopLiveNodes(liveNodes);
});

/**
 * Spawned asynchronously: the gateway the CLI talks to runs in this very process, so a
 * blocking `spawnSync` would deadlock it.
 */
function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, ["cli.ts", "--gateway", liveGateway.url, "--issuer", ISSUER, ...args], { cwd: LOGIN_DIR });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("cli.ts: the browser played from a terminal", () => {
  it("signs alice in, prints one access token line on stdout, and traces to stderr without the password", async () => {
    const result = await runCli(["--user", "alice", "--password", "password123", "--refresh"]);

    expect(result.status).toBe(0);

    const stdoutLines = result.stdout.trim().split("\n");
    expect(stdoutLines).toHaveLength(1);
    const at = verifyJwt(stdoutLines[0], groupPublicKey);
    expect(at.header.typ).toBe("at+jwt");

    expect(result.stderr).toContain("[browser]");
    expect(result.stderr).not.toContain("password123");
  });

  it("exits 1 with a wrong password, tracing the sign-on failure to stderr", async () => {
    const result = await runCli(["--user", "alice", "--password", "WRONG-password"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✖ sign-on failed");
    expect(result.stderr).not.toContain("WRONG-password");
  });

  it("with --jkt plays only the login page: prints the assertion bound to that key and stops", async () => {
    const jkt = "A".repeat(43);
    const result = await runCli(["--user", "alice", "--password", "password123", "--jkt", jkt, "--nonce", "c-jkt"]);

    expect(result.status).toBe(0);
    const [assertion, ...rest] = result.stdout.trim().split("\n");
    expect(rest).toHaveLength(0);
    const { header, payload } = verifyJwt(assertion, groupPublicKey);
    expect(header.typ).toBe("JWT");
    expect(payload.cnf).toEqual({ jkt });
    expect(payload.nonce).toBe("c-jkt");
    expect(result.stderr).not.toContain("token ");
  });

  it("exits 1 when --password is missing", async () => {
    const result = await runCli(["--user", "alice"]);

    expect(result.status).toBe(1);
  });
});
