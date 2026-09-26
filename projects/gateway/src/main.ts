import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { PaymentTerms, USDC, evmSettler } from "@decentralized-idp/sdk/x402";
import { Gateway } from "./domain/usecase/gateway.js";
import { createDemoLog } from "./http/demo-log.js";
import { createGatewayServer } from "./http/server.js";
import { loadClients } from "./infra/clients.js";
import { systemClock } from "./infra/clock.js";
import { FileCreditStore } from "./infra/credit-store.js";
import { loadGroup } from "./infra/group.js";
import { loadIdentity, signClientAssertion } from "./infra/identity.js";
import { discoverNodes } from "./infra/node.js";

/** Configuration comes from the environment; the README lists every variable. */
const port = Number(process.env.PORT || 3000);
const issuer = (process.env.ISSUER || `http://localhost:${port}`).replace(/\/+$/, "");
const group = loadGroup(process.env.GROUP_CONFIG || "/secrets/group.json", issuer);
const clients = loadClients(process.env.CLIENTS_CONFIG || "/secrets/clients.json");
const identity = loadIdentity(process.env.GATEWAY_KEY_FILE || "/secrets/gateway.json");
const nodeUrls = (process.env.NODE_URLS || "http://localhost:4001,http://localhost:4002,http://localhost:4003")
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter((url) => url !== "");
const loginDist = process.env.LOGIN_DIST || "/app/ui";
const rpOrigin = (process.env.RP_ORIGIN || "http://localhost:3001").replace(/\/+$/, "");
const network = (process.env.NETWORK || "eip155:84532") as keyof typeof USDC;
if (!(network in USDC)) throw new Error(`NETWORK must be one of ${Object.keys(USDC).join(", ")}`);
const rpcUrl = process.env.RPC_URL || "https://sepolia.base.org";

// The RP pays the gateway for /token; the gateway settles it itself, paying the gas from its wallet.
const terms: PaymentTerms = {
  ...USDC[network],
  payTo: identity.wallet.address,
  unitAmount: BigInt(process.env.PRICE_TOKEN || 10000),
  batch: Number(process.env.CREDIT_BATCH || 100),
};
const credits = new FileCreditStore(process.env.CREDITS_FILE || "/data/credits.json");
const settler = evmSettler(network, rpcUrl, identity.wallet.privateKey);

// The gateway pays each node for /sign: a 402 is paid from the same wallet and the call retried.
const payer = new x402Client().register(network, new ExactEvmScheme(privateKeyToAccount(identity.wallet.privateKey)));
const caller = {
  fetch: wrapFetchWithPayment(fetch, payer),
  clientAssertion: (aud: string) => signClientAssertion(identity, aud, systemClock.nowSeconds()),
};

console.log(`[gateway] issuer=${issuer} threshold=${group.threshold} nodes=${nodeUrls.join(", ")}`);
console.log(`[gateway] clients=${clients.map((c) => c.clientId).join(", ")}`);
console.log(`[gateway] network=${network} wallet=${identity.wallet.address} /token=${terms.unitAmount} ×${terms.batch}`);
const nodes = await discoverNodes(nodeUrls, group, caller);
const gateway: Gateway = { group, nodes, clients, clock: systemClock, billing: { terms, credits, settler } };
const demo = createDemoLog();

createGatewayServer(gateway, demo, { loginDist, rpOrigin }).listen(port, () => {
  console.log(`[gateway] listening on http://0.0.0.0:${port}  ui=${loginDist} rp=${rpOrigin}`);
  demo.startup({ issuer, threshold: group.threshold, total: nodes.length, keyId: group.keyId });
});
