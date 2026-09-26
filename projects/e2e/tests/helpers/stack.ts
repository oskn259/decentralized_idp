import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Gateway } from "../../../gateway/src/domain/usecase/gateway.js";
import { createDemoLog as gatewayDemoLog } from "../../../gateway/src/http/demo-log.js";
import { createGatewayServer } from "../../../gateway/src/http/server.js";
import { loadGroup } from "../../../gateway/src/infra/group.js";
import { HttpNode } from "../../../gateway/src/infra/node.js";
import { createDemoLog as nodeDemoLog } from "../../../node/src/http/demo-log.js";
import { createNodeServer } from "../../../node/src/http/server.js";
import { loadNodeConfig, nodeFromConfig } from "../../../node/src/infra/node.js";
import { createRpServer } from "../../../rp/src/http/server.js";

/**
 * The whole system in this process, over real HTTP on 127.0.0.1: three nodes from the node
 * project's key fixtures, the gateway serving the login page as `npm run build --prefix
 * projects/idpFront` produced it, and the relying party. Everything runs on the real clock,
 * as the relying party's OAuth client does.
 */

export const CLIENT_ID = "demo_client";
export const SCOPE = "profile";

const projects = fileURLToPath(new URL("../../..", import.meta.url));
const fixture = (name: string) => path.join(projects, "node", "tests", "fixtures", name);
const loginDist = path.join(projects, "idpFront", "dist");

export interface LiveServer {
  url: string;
  close(): Promise<void>;
}

export interface LiveNode extends LiveServer {
  nodeId: number;
}

export interface Stack {
  gatewayUrl: string;
  rpUrl: string;
  /** In `nodeId` order. Closing one is how a test takes a node down. */
  nodes: LiveNode[];
  close(): Promise<void>;
}

/** A port nothing listens on right now, for a server whose URL must be known before it starts. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function listen(server: http.Server, port: number): Promise<LiveServer> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

async function startNode(fixtureName: string, issuer: string): Promise<LiveNode> {
  const config = loadNodeConfig(fixture(fixtureName));
  const node = nodeFromConfig(config, issuer);
  const server = createNodeServer(node, nodeDemoLog({ nodeId: config.nodeId, env: { DEMO_LOG: "0" } }));
  return { nodeId: config.nodeId, ...(await listen(server, 0)) };
}

async function startGateway(issuer: string, port: number, nodes: LiveNode[], rpOrigin: string): Promise<LiveServer> {
  const gateway: Gateway = {
    group: loadGroup(fixture("group.json"), issuer),
    nodes: nodes.map((n) => new HttpNode(n.nodeId, n.url)),
    clock: { nowSeconds: () => Math.floor(Date.now() / 1000) },
  };
  const server = createGatewayServer(gateway, gatewayDemoLog({ env: { DEMO_LOG: "0" } }), { loginDist, rpOrigin });
  return listen(server, port);
}

export async function startStack(): Promise<Stack> {
  if (!fs.existsSync(path.join(loginDist, "index.html"))) {
    throw new Error(`no login page at ${loginDist}: run \`npm run build --prefix projects/idpFront\` first`);
  }
  const [gatewayPort, rpPort] = await Promise.all([freePort(), freePort()]);
  const issuer = `http://127.0.0.1:${gatewayPort}`;
  const rpUrl = `http://127.0.0.1:${rpPort}`;

  const nodes = await Promise.all(["node-1.json", "node-2.json", "node-3.json"].map((f) => startNode(f, issuer)));
  const gateway = await startGateway(issuer, gatewayPort, nodes, rpUrl);
  const rp = await listen(await createRpServer({ gatewayUrl: issuer, rpUrl, clientId: CLIENT_ID, scope: SCOPE }), rpPort);

  return {
    gatewayUrl: gateway.url,
    rpUrl: rp.url,
    nodes,
    close: async () => {
      await rp.close();
      await gateway.close();
      await Promise.all(nodes.map((n) => n.close()));
    },
  };
}
