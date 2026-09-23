import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Clock } from "../../../node/src/domain/infra/clock.js";
import { createDemoLog } from "../../../node/src/http/demo-log.js";
import { createNodeServer } from "../../../node/src/http/server.js";
import { loadNodeConfig, nodeFromConfig } from "../../../node/src/infra/node.js";

/** A real identity node (`../node`) in process, over real HTTP on an ephemeral port. */

export function nodeFixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../node/tests/fixtures/${name}`, import.meta.url));
}

export interface LiveNode {
  nodeId: number;
  url: string;
  close(): Promise<void>;
}

export interface StartLiveNodeOptions {
  issuer: string;
  clock: Clock;
}

export async function startLiveNode(fixtureName: string, options: StartLiveNodeOptions): Promise<LiveNode> {
  const config = loadNodeConfig(nodeFixturePath(fixtureName));
  const node = nodeFromConfig(config, options.issuer);
  node.clock = options.clock;
  const demo = createDemoLog({ nodeId: config.nodeId, env: { DEMO_LOG: "0" } });
  const server = createNodeServer(node, demo);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    nodeId: config.nodeId,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function startLiveNodes(options: StartLiveNodeOptions): Promise<LiveNode[]> {
  return Promise.all(["node-1.json", "node-2.json", "node-3.json"].map((f) => startLiveNode(f, options)));
}

export async function stopLiveNodes(nodes: LiveNode[]): Promise<void> {
  await Promise.all(nodes.map((n) => n.close()));
}
