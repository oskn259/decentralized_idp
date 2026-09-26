import http from "node:http";
import type { AddressInfo } from "node:net";
import { IdentityNode } from "../../src/domain/usecase/identity-node.js";
import { DemoLog, createDemoLog } from "../../src/http/demo-log.js";
import { createNodeServer } from "../../src/http/server.js";
import { BuildNodeOptions, buildNodeFromFixture } from "./build-node.js";

/** A node server bound to an ephemeral port, as a real HTTP endpoint. */
export interface RunningNode {
  nodeId: number;
  url: string;
  node: IdentityNode;
  server: http.Server;
  close(): Promise<void>;
}

/** Starts one node server on 127.0.0.1:0. */
export async function startNode(node: IdentityNode, demo: DemoLog): Promise<RunningNode> {
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
    nodeId: node.identity.nodeId,
    url: `http://127.0.0.1:${port}`,
    node,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface StartNodeOptions extends BuildNodeOptions {
  demoLog?: DemoLog;
}

/** A fixture node, with the users file it reads and writes. */
export interface FixtureNode extends RunningNode {
  usersFile: string;
}

/**
 * The demo log is off unless a test asks for one: three nodes tracing every round would
 * bury the test output, and only `demo-log.test.ts` looks at those lines.
 */
export async function startNodeFromFixture(name: string, options: StartNodeOptions = {}): Promise<FixtureNode> {
  const { node, config, usersFile } = buildNodeFromFixture(name, options);
  const demo = options.demoLog ?? createDemoLog({ nodeId: config.nodeId, env: { DEMO_LOG: "0" } });
  return { ...(await startNode(node, demo)), usersFile };
}

/**
 * Starts node-1, node-2 and node-3 from the fixtures, sharing one clock unless told otherwise.
 * `usersFiles[i]` restarts node i+1 on a users file a previous run wrote.
 */
export async function startAllNodes(options: StartNodeOptions & { usersFiles?: string[] } = {}): Promise<FixtureNode[]> {
  return Promise.all(
    ["node-1.json", "node-2.json", "node-3.json"].map((f, i) => startNodeFromFixture(f, { ...options, usersFile: options.usersFiles?.[i] }))
  );
}

export async function stopAll(nodes: RunningNode[]): Promise<void> {
  await Promise.all(nodes.map((n) => n.close()));
}

export interface JsonResponse {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

/** Reads the reply as text and, where it parses, as JSON; a non-JSON body leaves `body` undefined. */
async function readJson(res: Response): Promise<JsonResponse> {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, headers: res.headers };
}

/** POSTs JSON (or raw text, to exercise malformed bodies) and reads the JSON reply. */
export async function postJson(
  url: string,
  path: string,
  body: unknown,
  options: { raw?: string; contentType?: string } = {}
): Promise<JsonResponse> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": options.contentType ?? "application/json" },
    body: options.raw ?? JSON.stringify(body),
  });
  return readJson(res);
}

export async function getJson(url: string, path: string): Promise<JsonResponse> {
  return readJson(await fetch(`${url}${path}`));
}

/** POSTs JSON and fails loudly on any non-200, so tests do not silently continue. */
export async function postJsonOrThrow(url: string, path: string, body: unknown): Promise<any> {
  const res = await postJson(url, path, body);
  if (res.status !== 200) {
    throw new Error(`POST ${path} -> ${res.status}: ${res.text}`);
  }
  return res.body;
}
