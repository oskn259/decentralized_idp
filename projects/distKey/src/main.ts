import path from "node:path";
import { parseArgs } from "node:util";
import { DistributedKeys, distributeKeys } from "./domain/usecase/distribute-keys.js";
import { existingOutputFiles, outputFileNames, outputFiles, writeOutputFiles } from "./infra/output.js";

const USAGE = `distKey - splits the group signing key across the nodes, and keys the demo parties

Usage:
  distKey --out <dir> [--threshold 2] [--total 3] [--clients demo_client] [--force]

Writes <dir>/group.json and <dir>/node-<id>.json for id 1..total (each with its wallet),
<dir>/clients.json (the relying parties' public keys, for the gateway), <dir>/client-<client_id>.json
(each one's private key and wallet), <dir>/gateway.json (the gateway's key and wallet) and
<dir>/gateways.json (its public key, for the nodes). Wallets start empty: fund them before use.
When every file is already there, nothing is written and the keys are kept (so a restart
does not rotate them). When only some are there, the run fails unless --force is given.
`;

type Sink = { write(text: string): unknown };

interface Options {
  help: boolean;
  out: string | undefined;
  threshold: number;
  total: number;
  clients: string[];
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
  const names = outputFileNames(options.total, options.clients);
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
    keys = distributeKeys(options.threshold, options.total, options.clients);
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
      clients: { type: "string", default: "demo_client" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    help: values.help,
    out: values.out,
    threshold: Number(values.threshold),
    total: Number(values.total),
    clients: values.clients.split(",").map((id) => id.trim()).filter((id) => id !== ""),
    force: values.force,
  };
}

function summary(dir: string, names: string[], keys: DistributedKeys): string {
  const wallets = [
    ...keys.clients.map((c) => `  ${c.clientId.padEnd(12)} ${c.wallet.address}  needs USDC`),
    `  ${"gateway".padEnd(12)} ${keys.gateway.wallet.address}  needs USDC and ETH`,
    ...keys.nodes.map((n) => `  ${`node${n.nodeId}`.padEnd(12)} ${n.wallet.address}  needs ETH`),
  ];
  return (
    `distKey: wrote ${names.length} files to ${dir}\n` +
    `  threshold=${keys.threshold} total=${keys.total} clients=${keys.clients.map((c) => c.clientId).join(",")}\n` +
    names.map((n) => `  ${path.join(dir, n)}\n`).join("") +
    `wallets to fund on the network the services are configured for:\n${wallets.join("\n")}\n`
  );
}

// Run only when started as a script (dist/main.js or tsx src/main.ts); the tests import main() instead.
if (process.argv[1] && path.basename(process.argv[1]).startsWith("main")) {
  // Set the exit code instead of calling process.exit(): piped stdout writes are asynchronous.
  process.exitCode = main(process.argv.slice(2));
}
