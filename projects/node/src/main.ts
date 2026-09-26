import { createDemoLog } from "./http/demo-log.js";
import { createNodeServer } from "./http/server.js";
import fs from "node:fs";
import { parseGateways } from "./infra/gateways.js";
import { nodeFromConfig, parseNodeConfig } from "./infra/node.js";
import { USDC } from "@decentralized-idp/sdk/x402";

/**
 * Environment:
 *   NODE_CONFIG      path of the dealer's node-<id>.json      (default /secrets/node.json)
 *   NODE_CONFIG_JSON the same file's content, for a platform whose secrets are environment variables
 *   USERS_FILE       registered users, kept across restarts    (default /data/users.json)
 *   PORT             listen port                               (default 4000)
 *   ISSUER           gateway URL as the browser sees it        (default http://localhost:3000)
 *   PUBLIC_URL       this node's URL as the browser sees it    (default http://localhost:<PORT>)
 *   GATEWAYS_CONFIG  gateways allowed to call /sign            (default /secrets/gateways.json)
 *   GATEWAYS_JSON    the same file's content
 *   NETWORK          CAIP-2 chain /sign is paid on             (default eip155:84532, Base Sepolia)
 *   RPC_URL          JSON-RPC endpoint of that chain           (default https://sepolia.base.org)
 *   PRICE_SIGN       atomic USDC units per /sign               (default 3000, 0.003 USDC)
 *   CREDIT_BATCH     /sign requests bought per payment         (default 100)
 *   CREDITS_FILE     credit left per gateway, kept on restarts (default /data/credits.json)
 *   DEMO_LOG, FORCE_COLOR                                      see http/demo-log.ts
 */

/** A secret file's content: given inline, or read from the path. */
const secretJson = (jsonVar: string, pathVar: string, defaultPath: string): string =>
  process.env[jsonVar] ?? fs.readFileSync(process.env[pathVar] || defaultPath, "utf8");

const usersFile = process.env.USERS_FILE || "/data/users.json";
const port = Number(process.env.PORT || 4000);
const issuer = (process.env.ISSUER || "http://localhost:3000").replace(/\/+$/, "");
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, "");

const network = process.env.NETWORK || "eip155:84532";
if (!(network in USDC)) throw new Error(`NETWORK must be one of ${Object.keys(USDC).join(", ")}`);
const billing = {
  gateways: parseGateways(secretJson("GATEWAYS_JSON", "GATEWAYS_CONFIG", "/secrets/gateways.json")),
  creditsFile: process.env.CREDITS_FILE || "/data/credits.json",
  network: network as keyof typeof USDC,
  rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
  unitAmount: BigInt(process.env.PRICE_SIGN || 3000),
  batch: Number(process.env.CREDIT_BATCH || 100),
};

const config = parseNodeConfig(secretJson("NODE_CONFIG_JSON", "NODE_CONFIG", "/secrets/node.json"));
const node = nodeFromConfig(config, { issuer, publicUrl, usersFile, billing });
const demo = createDemoLog({ nodeId: config.nodeId });

createNodeServer(node, demo).listen(port, () => {
  console.log(
    `[node] nodeId=${config.nodeId} threshold=${config.threshold}/${config.total} ` +
      `issuer=${issuer} publicUrl=${publicUrl} users=${usersFile}`
  );
  console.log(
    `[node] wallet=${config.wallet.address} network=${network} price=${billing.unitAmount}x${billing.batch} ` +
      `gateways=${node.billing.gateways.map((g) => g.clientId).join(",")} credits=${billing.creditsFile}`
  );
  console.log(`[node] listening on http://0.0.0.0:${port}`);
  demo.startup({ threshold: config.threshold, total: config.total });
});
