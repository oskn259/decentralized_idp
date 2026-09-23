import path from "node:path";
import { parseArgs } from "node:util";
import { DistributedKeys, distributeKeys, UserSpec } from "./domain/usecase/distribute-keys.js";
import { existingOutputFiles, outputFileNames, outputFiles, writeOutputFiles } from "./infra/output.js";

const DEFAULT_USERS: UserSpec[] = [
  { username: "alice", password: "password123", sub: "usr_alice_12345" },
  { username: "bob", password: "password456", sub: "usr_bob_67890" },
];

const USAGE = `distKey - splits the group signing key and each user's TOPRF key across the nodes

Usage:
  distKey --out <dir> [--threshold 2] [--total 3] [--users <u>:<pw>:<sub>,...] [--force]

Writes <dir>/group.json and <dir>/node-<id>.json for id 1..total. Passwords are never written.
When every file is already there, nothing is written and the keys are kept (so a restart
does not rotate them). When only some are there, the run fails unless --force is given.
Default users: ${DEFAULT_USERS.map((u) => `${u.username}:<password>:${u.sub}`).join(", ")}
`;

type Sink = { write(text: string): unknown };

interface Options {
  help: boolean;
  out: string | undefined;
  threshold: number;
  total: number;
  users: string | undefined;
  force: boolean;
}

/** Runs the command and returns the exit code. */
export function main(argv: string[], out: Sink = process.stdout, err: Sink = process.stderr): number {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (e) {
    err.write(`${(e as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (options.help) {
    out.write(USAGE);
    return 0;
  }
  if (!options.out) {
    err.write(`error: --out <dir> is required\n\n${USAGE}`);
    return 1;
  }

  const dir = path.resolve(options.out);
  const names = outputFileNames(options.total);
  const existing = existingOutputFiles(dir, names);
  if (existing === "all" && !options.force) {
    out.write(`distKey: ${names.length} key files already present in ${dir}, keeping them\n`);
    return 0;
  }
  if (existing === "some" && !options.force) {
    err.write(`error: ${dir} holds only part of a key set (expected ${names.join(", ")}); pass --force to replace it\n`);
    return 1;
  }

  let keys: DistributedKeys;
  try {
    const users = options.users === undefined ? DEFAULT_USERS : parseUsers(options.users);
    keys = distributeKeys(options.threshold, options.total, users);
  } catch (e) {
    err.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
  writeOutputFiles(dir, outputFiles(keys));
  out.write(summary(dir, names, keys));
  return 0;
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string" },
      threshold: { type: "string", default: "2" },
      total: { type: "string", default: "3" },
      users: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    help: values.help,
    out: values.out,
    threshold: Number(values.threshold),
    total: Number(values.total),
    users: values.users,
    force: values.force,
  };
}

/** `<username>:<password>:<sub>,...` — the first and last colon separate, so a password may contain colons. */
export function parseUsers(value: string): UserSpec[] {
  return value.split(",").map((entry) => {
    const invalid = `invalid --users entry "${entry}": expected <username>:<password>:<sub>`;
    const first = entry.indexOf(":");
    const last = entry.lastIndexOf(":");
    if (first === -1 || last === first) {
      throw new Error(invalid);
    }
    const username = entry.slice(0, first);
    const password = entry.slice(first + 1, last);
    const sub = entry.slice(last + 1);
    if (!username || !password || !sub) {
      throw new Error(invalid);
    }
    return { username, password, sub };
  });
}

function summary(dir: string, names: string[], keys: DistributedKeys): string {
  // Every node lists every user, so any node's list is the whole set.
  const usernames = keys.nodes[0].users.map((u) => u.username).join(",");
  return (
    `distKey: wrote ${names.length} files to ${dir}\n` +
    `  threshold=${keys.threshold} total=${keys.total} users=${usernames}\n` +
    names.map((n) => `  ${path.join(dir, n)}\n`).join("")
  );
}

// Run only when started as a script (dist/main.js or tsx src/main.ts); the tests import main() instead.
if (process.argv[1] && path.basename(process.argv[1]).startsWith("main")) {
  // Set the exit code instead of calling process.exit(): piped stdout writes are asynchronous.
  process.exitCode = main(process.argv.slice(2));
}
