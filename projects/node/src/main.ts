import { createDemoLog } from "./http/demo-log.js";
import { createNodeServer } from "./http/server.js";
import { loadNodeConfig, nodeFromConfig } from "./infra/node.js";
import { USDC } from "@decentralized-idp/sdk/x402";

/**
 * Environment:
 *   NODE_CONFIG      path of the dealer's node-<id>.json      (default /secrets/node.json)
 *   USERS_FILE       registered users, kept across restarts    (default /data/users.json)
 *   PORT             listen port                               (default 4000)
 *   ISSUER           gateway URL as the browser sees it        (default http://localhost:3000)
 *   PUBLIC_URL       this node's URL as the browser sees it    (default http://localhost:<PORT>)
 *   GATEWAYS_CONFIG  gateways allowed to call /sign            (default /secrets/gateways.json)
 *   NETWORK          CAIP-2 chain /sign is paid on             (default eip155:84532, Base Sepolia)
 *   RPC_URL          JSON-RPC endpoint of that chain           (default https://sepolia.base.org)
 *   PRICE_SIGN       atomic USDC units per /sign               (default 3000, 0.003 USDC)
 *   CREDIT_BATCH     /sign requests bought per payment         (default 100)
 *   CREDITS_FILE     credit left per gateway, kept on restarts (default /data/credits.json)
 *   DEMO_LOG, FORCE_COLOR                                      see http/demo-log.ts
 */

const configPath = process.env.NODE_CONFIG || "/secrets/node.json";
const usersFile = process.env.USERS_FILE || "/data/users.json";
const port = Number(process.env.PORT || 4000);
const issuer = (process.env.ISSUER || "http://localhost:3000").replace(/\/+$/, "");
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, "");

const network = process.env.NETWORK || "eip155:84532";
if (!(network in USDC)) throw new Error(`NETWORK must be one of ${Object.keys(USDC).join(", ")}`);
const billing = {
  gatewaysFile: process.env.GATEWAYS_CONFIG || "/secrets/gateways.json",
  creditsFile: process.env.CREDITS_FILE || "/data/credits.json",
  network: network as keyof typeof USDC,
  rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
  unitAmount: BigInt(process.env.PRICE_SIGN || 3000),
  batch: Number(process.env.CREDIT_BATCH || 100),
};

const config = loadNodeConfig(configPath);
const node = nodeFromConfig(config, { issuer, publicUrl, usersFile, billing });
const demo = createDemoLog({ nodeId: config.nodeId });

createNodeServer(node, demo).listen(port, () => {
  console.log(
    `[node] nodeId=${config.nodeId} threshold=${config.threshold}/${config.total} ` +
      `issuer=${issuer} publicUrl=${publicUrl} config=${configPath} users=${usersFile}`
  );
  console.log(
    `[node] wallet=${config.wallet.address} network=${network} price=${billing.unitAmount}x${billing.batch} ` +
      `gateways=${node.billing.gateways.map((g) => g.clientId).join(",")} credits=${billing.creditsFile}`
  );
  console.log(`[node] listening on http://0.0.0.0:${port}`);
  demo.startup({ threshold: config.threshold, total: config.total });
});
