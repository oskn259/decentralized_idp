import { createRpServer } from "./http/server.js";

const port = Number(process.env.PORT || 3001);
const options = {
  gatewayUrl: (process.env.GATEWAY_URL || "http://localhost:3000").replace(/\/+$/, ""),
  rpUrl: (process.env.RP_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
  clientId: process.env.CLIENT_ID || "demo_client",
  scope: process.env.SCOPE || "profile",
};

const server = await createRpServer(options);
server.listen(port, () => {
  console.log(`[rp] listening on http://0.0.0.0:${port}  gateway=${options.gatewayUrl} rp=${options.rpUrl} client_id=${options.clientId}`);
});
