import fs from "node:fs";
import { createRpServer } from "./http/server.js";
import { createOAuthClient } from "./oauth.js";
import { payWith } from "./x402.js";

/**
 * Environment:
 *   GATEWAY_URL      the OAuth issuer                       (default http://localhost:3000)
 *   RP_URL           this relying party's public URL        (default http://localhost:<PORT>)
 *   CLIENT_ID        (default demo_client)
 *   CLIENT_KEY_FILE  `{ client_id, key: <private Ed25519 JWK>, wallet: { address, privateKey } }`, as distKey
 *                    writes it: the key signs private_key_jwt, the wallet pays the gateway over x402
 *                                                           (default /secrets/client-<CLIENT_ID>.json)
 *   CLIENT_KEY_JSON  the same file's content, for a platform whose secrets are environment variables
 *   NETWORK          CAIP-2 chain the wallet pays on         (default eip155:84532, Base Sepolia)
 *   SCOPE, PORT
 */

const port = Number(process.env.PORT || 3001);
const gatewayUrl = (process.env.GATEWAY_URL || "http://localhost:3000").replace(/\/+$/, "");
const rpUrl = (process.env.RP_URL || `http://localhost:${port}`).replace(/\/+$/, "");
const clientId = process.env.CLIENT_ID || "demo_client";
const clientKeyFile = process.env.CLIENT_KEY_FILE || `/secrets/client-${clientId}.json`;
const { key, wallet } = JSON.parse(process.env.CLIENT_KEY_JSON ?? fs.readFileSync(clientKeyFile, "utf8")) as {
  key: JsonWebKey & { kid?: string };
  wallet: { privateKey: `0x${string}` };
};

const clientKey = { key: await crypto.subtle.importKey("jwk", key, { name: "Ed25519" }, false, ["sign"]), kid: key.kid };
const redirectUri = `${rpUrl}/callback`;
const scope = process.env.SCOPE || "profile";
const network = (process.env.NETWORK || "eip155:84532") as `${string}:${string}`;

const client = await createOAuthClient({ issuer: gatewayUrl, clientId, clientKey, redirectUri, scope });
payWith(client.config, { privateKey: wallet.privateKey, network });

createRpServer(client).listen(port, () => {
  console.log(`[rp] listening on http://0.0.0.0:${port}  gateway=${gatewayUrl} rp=${rpUrl} client_id=${clientId}`);
});
