import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_URL, up } from "./helpers/compose.js";

/**
 * The browser played from a terminal: `idpFront/cli.ts` as a child process against the
 * containers. What it prints is the contract: one JWT line on stdout, the trace on stderr.
 * Tokens are checked with node:crypto against the gateway's published JWKS, as any
 * resource server would.
 */

const projects = fileURLToPath(new URL("../..", import.meta.url));
const tsx = `${projects}/../node_modules/.bin/tsx`;

beforeAll(() => {
  up();
});

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, ["cli.ts", "--gateway", GATEWAY_URL, ...args], { cwd: `${projects}/idpFront` });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Verifies the JWT's Ed25519 signature against `/jwks.json` and returns its header and payload. */
async function verified(jwt: string): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown> }> {
  const jwks = (await (await fetch(`${GATEWAY_URL}/jwks.json`)).json()) as { keys: Array<{ kid: string; kty: string; crv: string; x: string }> };
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  expect(jwk).toBeDefined();
  const key = crypto.createPublicKey({ key: { kty: jwk!.kty, crv: jwk!.crv, x: jwk!.x }, format: "jwk" });
  expect(crypto.verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))).toBe(true);
  return { header, payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")) };
}

describe("cli.ts against the containers", () => {
  it("signs alice in, prints one access token line on stdout, and traces to stderr without the password", async () => {
    const result = await runCli(["--user", "alice", "--password", "password123", "--refresh"]);
    expect(result.status).toBe(0);

    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const { header, payload } = await verified(lines[0]);
    expect(header.typ).toBe("at+jwt");
    expect(payload.sub).toBe("usr_alice_12345");

    expect(result.stderr).toContain("[browser]");
    expect(result.stderr).not.toContain("password123");
  });

  it("exits 1 with a wrong password, tracing the sign-on failure to stderr without the password", async () => {
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
    const { header, payload } = await verified(assertion);
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
