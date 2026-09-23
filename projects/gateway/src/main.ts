import { Gateway } from "./domain/usecase/gateway.js";
import { createDemoLog } from "./http/demo-log.js";
import { createGatewayServer } from "./http/server.js";
import { systemClock } from "./infra/clock.js";
import { loadGroup } from "./infra/group.js";
import { discoverNodes } from "./infra/node.js";

/** Configuration comes from the environment; the README lists every variable. */
const port = Number(process.env.PORT || 3000);
const issuer = (process.env.ISSUER || `http://localhost:${port}`).replace(/\/+$/, "");
const group = loadGroup(process.env.GROUP_CONFIG || "/secrets/group.json", issuer);
const nodeUrls = (process.env.NODE_URLS || "http://localhost:4001,http://localhost:4002,http://localhost:4003")
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter((url) => url !== "");
const loginDist = process.env.LOGIN_DIST || "/app/ui";
const rpOrigin = (process.env.RP_ORIGIN || "http://localhost:3001").replace(/\/+$/, "");

console.log(`[gateway] issuer=${issuer} threshold=${group.threshold} nodes=${nodeUrls.join(", ")}`);
const nodes = await discoverNodes(nodeUrls, group);
const gateway: Gateway = { group, nodes, clock: systemClock };
const demo = createDemoLog();

createGatewayServer(gateway, demo, { loginDist, rpOrigin }).listen(port, () => {
  console.log(`[gateway] listening on http://0.0.0.0:${port}  ui=${loginDist} rp=${rpOrigin}`);
  demo.startup({ issuer, threshold: group.threshold, total: nodes.length, keyId: group.keyId });
});
