import { createDemoLog } from "./http/demo-log.js";
import { createNodeServer } from "./http/server.js";
import { loadNodeConfig, nodeFromConfig } from "./infra/node.js";

/**
 * Environment:
 *   NODE_CONFIG  path of the dealer's node-<id>.json   (default /secrets/node.json)
 *   PORT         listen port                            (default 4000)
 *   ISSUER       gateway URL as the browser sees it     (default http://localhost:3000)
 *   DEMO_LOG, FORCE_COLOR                               see http/demo-log.ts
 */

const configPath = process.env.NODE_CONFIG || "/secrets/node.json";
const port = Number(process.env.PORT || 4000);
const issuer = (process.env.ISSUER || "http://localhost:3000").replace(/\/+$/, "");

const config = loadNodeConfig(configPath);
const node = nodeFromConfig(config, issuer);
const demo = createDemoLog({ nodeId: config.nodeId });

createNodeServer(node, demo).listen(port, () => {
  console.log(
    `[node] nodeId=${config.nodeId} threshold=${config.threshold}/${config.total} ` +
      `users=${config.users.length} issuer=${issuer} config=${configPath}`
  );
  console.log(`[node] listening on http://0.0.0.0:${port}`);
  demo.startup({
    threshold: config.threshold,
    total: config.total,
    usernames: config.users.map((u) => u.username),
  });
});
