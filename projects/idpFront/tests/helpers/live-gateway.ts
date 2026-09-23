import type { AddressInfo } from "node:net";
import { Clock } from "../../../gateway/src/domain/infra/clock.js";
import { Gateway } from "../../../gateway/src/domain/usecase/gateway.js";
import { createDemoLog } from "../../../gateway/src/http/demo-log.js";
import { createGatewayServer } from "../../../gateway/src/http/server.js";
import { loadGroup } from "../../../gateway/src/infra/group.js";
import { HttpNode } from "../../../gateway/src/infra/node.js";
import { LiveNode, nodeFixturePath } from "./live-node.js";
import { makeTempDist } from "./temp-dist.js";

/** A real gateway (`../gateway`) in process, over real HTTP, in front of running `LiveNode`s. */

export interface LiveGatewayOptions {
  issuer: string;
  clock: Clock;
  rpOrigin: string;
  nodes: LiveNode[];
  /** Listen here instead of an ephemeral port, for a test whose issuer must be the gateway's own URL. */
  port?: number;
}

export interface LiveGateway {
  url: string;
  close(): Promise<void>;
}

export async function startLiveGateway(options: LiveGatewayOptions): Promise<LiveGateway> {
  const group = loadGroup(nodeFixturePath("group.json"), options.issuer);
  const gateway: Gateway = {
    group,
    nodes: options.nodes.map((n) => new HttpNode(n.nodeId, n.url)),
    clock: options.clock,
  };
  const dist = makeTempDist();
  const demo = createDemoLog({ env: { DEMO_LOG: "0" } });
  const server = createGatewayServer(gateway, demo, { loginDist: dist.dir, rpOrigin: options.rpOrigin });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }).then(() => dist.cleanup()),
  };
}
