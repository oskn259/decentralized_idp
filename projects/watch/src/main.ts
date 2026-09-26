import fs from "node:fs";
import path from "node:path";
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { USDC } from "@decentralized-idp/sdk/x402";

interface Entity {
  label: string;
  address: `0x${string}`;
}

// `npm run watch` runs this from projects/watch; INIT_CWD is where the user typed the command.
const dir = path.resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2] ?? "secrets");
const rpcUrl = process.env.RPC_URL ?? "https://sepolia.base.org";
const network = (process.env.NETWORK ?? "eip155:84532") as keyof typeof USDC;
const intervalMs = Number(process.env.INTERVAL ?? "3") * 1000;

if (!USDC[network]) throw new Error(`NETWORK must be one of ${Object.keys(USDC).join(", ")}`);
const client = createPublicClient({ transport: http(rpcUrl) });

/** Only the wallet address is read; the private key next to it is never touched. */
function readEntity(file: string): Entity {
  const json = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const label = file === "gateway.json" ? "gateway" : file.startsWith("node-") ? `node${json.nodeId}` : json.client_id;
  return { label, address: json.wallet.address };
}

function listEntities(): Entity[] {
  const files = fs.readdirSync(dir).sort();
  const clients = files.filter((file) => /^client-.+\.json$/.test(file));
  const nodes = files.filter((file) => /^node-\d+\.json$/.test(file));
  return [...clients, "gateway.json", ...nodes].map(readEntity);
}

function fetchBalance(entity: Entity): Promise<bigint> {
  return client.readContract({ address: USDC[network].asset, abi: erc20Abi, functionName: "balanceOf", args: [entity.address] });
}

function fetchBalances(entities: Entity[]): Promise<bigint[]> {
  return Promise.all(entities.map(fetchBalance));
}

function usdc(amount: bigint): string {
  const [whole, fraction = ""] = formatUnits(amount, 6).split(".");
  return `${whole}.${fraction.padEnd(6, "0")}`;
}

function signed(amount: bigint): string {
  return amount > 0n ? `+${usdc(amount)}` : usdc(amount);
}

function row(entity: Entity, balance: bigint, previous: bigint, start: bigint): string {
  const mark = balance > previous ? "▲" : balance < previous ? "▼" : " ";
  return `${entity.label.padEnd(14)} ${entity.address}  ${usdc(balance).padStart(12)} ${mark}  ${signed(balance - start).padStart(12)}`;
}

function render(entities: Entity[], balances: bigint[], previous: bigint[], start: bigint[], updatedAt: Date, warning?: string): void {
  console.clear();
  console.log(`USDC on ${network} via ${rpcUrl}  (every ${intervalMs / 1000}s)\n`);
  console.log(`${"entity".padEnd(14)} ${"address".padEnd(42)}  ${"USDC".padStart(12)}    ${"Δ".padStart(12)}`);
  entities.forEach((entity, i) => console.log(row(entity, balances[i], previous[i], start[i])));
  console.log(`\nupdated ${updatedAt.toLocaleTimeString()}`);
  if (warning) console.log(`warning: RPC failed, showing last values: ${warning}`);
}

const entities = listEntities();
const start = await fetchBalances(entities);
let last = start;
let updatedAt = new Date();
render(entities, last, last, start, updatedAt);

setInterval(async () => {
  try {
    const balances = await fetchBalances(entities);
    updatedAt = new Date();
    render(entities, balances, last, start, updatedAt);
    last = balances;
  } catch (error) {
    render(entities, last, last, start, updatedAt, (error as Error).message.split("\n")[0]);
  }
}, intervalMs);
