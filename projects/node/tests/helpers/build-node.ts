import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { Settler } from "@decentralized-idp/sdk/x402";
import { Clock } from "../../src/domain/infra/clock.js";
import { IdentityNode } from "../../src/domain/usecase/identity-node.js";
import { loadNodeConfig, NodeConfig, nodeFromConfig } from "../../src/infra/node.js";

/**
 * Test-only building blocks shared by every suite: fixture access, a clock a test can move
 * by hand, settlers that stand in for the chain, and an `IdentityNode` built from one of the
 * dealer fixtures.
 */

/** Every users or credits file a test file creates lives here, and goes when that test file ends. */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "node-data-"));
afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

/** A path in the temporary directory where no users file exists yet. */
export function newUsersFile(): string {
  return path.join(fs.mkdtempSync(path.join(DATA_DIR, "n-")), "users.json");
}

/** A path in the temporary directory where no credits file exists yet. */
export function newCreditsFile(): string {
  return path.join(fs.mkdtempSync(path.join(DATA_DIR, "c-")), "credits.json");
}

/** The chain accepts every payment. */
export const settlingSettler: Settler = {
  settle: async (_payment, requirements) => ({
    success: true,
    transaction: "0x" + "ab".repeat(32),
    network: requirements.network,
    payer: "0x" + "cd".repeat(20),
  }),
};

/** The chain refuses every payment, as with an unfunded payer. */
export const failingSettler: Settler = {
  settle: async (_payment, requirements) => ({
    success: false,
    errorReason: "insufficient_funds",
    errorMessage: "payer has no USDC",
    transaction: "",
    network: requirements.network,
  }),
};

/** Two requests per payment, so a test runs out of credit quickly. */
export const TEST_BATCH = 2;
export const TEST_UNIT_AMOUNT = 3000n;

export const TEST_ISSUER = "http://localhost:3000";

/** The URL a fixture node reports in `/health`, unless a test passes its own. */
export function testPublicUrl(nodeId: number): string {
  return `http://node${nodeId}.test`;
}

/** Absolute path of a file in `tests/fixtures/`. */
export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

/** Reads a fixture as parsed JSON. */
export function readFixtureJson(name: string): any {
  return JSON.parse(fs.readFileSync(fixturePath(name), "utf8"));
}

/** A `Clock` a test drives directly, instead of `vi.useFakeTimers`. */
export class FakeClock implements Clock {
  private seconds: number;

  constructor(seconds: number = Math.floor(Date.now() / 1000)) {
    this.seconds = seconds;
  }

  nowSeconds(): number {
    return this.seconds;
  }

  set(seconds: number): void {
    this.seconds = seconds;
  }

  advance(deltaSeconds: number): void {
    this.seconds += deltaSeconds;
  }
}

export interface BuildNodeOptions {
  issuer?: string;
  publicUrl?: string;
  clock?: Clock;
  /** Defaults to a fresh file, so the node starts with no users. */
  usersFile?: string;
  /** Defaults to a fresh file, so the node starts with no credit. */
  creditsFile?: string;
  /** Defaults to `settlingSettler`. */
  settler?: Settler;
}

/** The real assembly from a fixture config, with the clock swapped for one the test controls. */
export function buildNodeFromFixture(
  name: string,
  options: BuildNodeOptions = {}
): { node: IdentityNode; config: NodeConfig; usersFile: string; creditsFile: string } {
  const config = loadNodeConfig(fixturePath(name));
  const usersFile = options.usersFile ?? newUsersFile();
  const creditsFile = options.creditsFile ?? newCreditsFile();
  const built = nodeFromConfig(config, {
    issuer: options.issuer ?? TEST_ISSUER,
    publicUrl: options.publicUrl ?? testPublicUrl(config.nodeId),
    usersFile,
    billing: {
      gatewaysFile: fixturePath("gateways.json"),
      creditsFile,
      network: "eip155:84532",
      rpcUrl: "http://127.0.0.1:1",
      unitAmount: TEST_UNIT_AMOUNT,
      batch: TEST_BATCH,
    },
  });
  const node = {
    ...built,
    clock: options.clock ?? new FakeClock(),
    billing: { ...built.billing, settler: options.settler ?? settlingSettler },
  };
  return { node, config, usersFile, creditsFile };
}

/** All three fixture nodes, in-process, sharing one clock unless told otherwise. */
export function buildAllNodesFromFixtures(options: BuildNodeOptions = {}): IdentityNode[] {
  const clock = options.clock ?? new FakeClock();
  return ["node-1.json", "node-2.json", "node-3.json"].map(
    (f) => buildNodeFromFixture(f, { ...options, clock }).node
  );
}
