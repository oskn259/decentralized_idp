import fs from "node:fs";
import { createRpServer } from "./http/server.js";

/**
 * Environment:
 *   GATEWAY_URL      the OAuth issuer                       (default http://localhost:3000)
 *   RP_URL           this relying party's public URL        (default http://localhost:<PORT>)
 *   CLIENT_ID        (default demo_client)
 *   CLIENT_KEY_FILE  `{ client_id, key: <private Ed25519 JWK> }` for private_key_jwt, as distKey writes it
 *                                                           (default /secrets/client-<CLIENT_ID>.json)
 *   SCOPE, PORT
 */

const port = Number(process.env.PORT || 3001);
const clientId = process.env.CLIENT_ID || "demo_client";
const clientKeyFile = process.env.CLIENT_KEY_FILE || `/secrets/client-${clientId}.json`;
const { key } = JSON.parse(fs.readFileSync(clientKeyFile, "utf8")) as { key: JsonWebKey & { kid?: string } };
const options = {
  gatewayUrl: (process.env.GATEWAY_URL || "http://localhost:3000").replace(/\/+$/, ""),
  rpUrl: (process.env.RP_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
  clientId,
  clientKey: { key: await crypto.subtle.importKey("jwk", key, { name: "Ed25519" }, false, ["sign"]), kid: key.kid },
  scope: process.env.SCOPE || "profile",
};

const server = await createRpServer(options);
server.listen(port, () => {
  console.log(`[rp] listening on http://0.0.0.0:${port}  gateway=${options.gatewayUrl} rp=${options.rpUrl} client_id=${options.clientId}`);
});
