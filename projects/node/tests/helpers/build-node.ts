import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { Clock } from "../../src/domain/infra/clock.js";
import { IdentityNode } from "../../src/domain/usecase/identity-node.js";
import { loadNodeConfig, NodeConfig, nodeFromConfig } from "../../src/infra/node.js";

/**
 * Test-only building blocks shared by every suite: fixture access, a clock a test can move
 * by hand, and an `IdentityNode` built from one of the dealer fixtures.
 */

/** Every users file a test file creates lives here, and goes when that test file ends. */
const USERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "node-users-"));
afterAll(() => fs.rmSync(USERS_DIR, { recursive: true, force: true }));

/** A path in the temporary directory where no users file exists yet. */
export function newUsersFile(): string {
  return path.join(fs.mkdtempSync(path.join(USERS_DIR, "n-")), "users.json");
}

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
}

/** The real assembly from a fixture config, with the clock swapped for one the test controls. */
export function buildNodeFromFixture(
  name: string,
  options: BuildNodeOptions = {}
): { node: IdentityNode; config: NodeConfig; usersFile: string } {
  const config = loadNodeConfig(fixturePath(name));
  const usersFile = options.usersFile ?? newUsersFile();
  const node = {
    ...nodeFromConfig(config, {
      issuer: options.issuer ?? TEST_ISSUER,
      publicUrl: options.publicUrl ?? testPublicUrl(config.nodeId),
      usersFile,
    }),
    clock: options.clock ?? new FakeClock(),
  };
  return { node, config, usersFile };
}

/** All three fixture nodes, in-process, sharing one clock unless told otherwise. */
export function buildAllNodesFromFixtures(options: BuildNodeOptions = {}): IdentityNode[] {
  const clock = options.clock ?? new FakeClock();
  return ["node-1.json", "node-2.json", "node-3.json"].map(
    (f) => buildNodeFromFixture(f, { ...options, clock }).node
  );
}
