import { z } from "zod";
import { bytesToHex } from "@decentralized-idp/sdk/hex";
import { Commitment } from "@decentralized-idp/sdk/frost";
import {
  commitRequest,
  commitResponse,
  healthResponse,
  signOnRequest,
  signOnResponse,
  signRequest,
  signResponse,
} from "@decentralized-idp/sdk/node-api";
import { Node, NodeHealth, NodeSignOnRequest, NodeSignOnResponse, NodeTokenRequest, NodeTokenShares } from "../domain/infra/node.js";
import { Group } from "../domain/value/group.js";

/** How long one node call may take before the node counts as unreachable for this round. */
export const NODE_TIMEOUT_MS = 5_000;

/** Requests and responses cross the wire in the shapes `@decentralized-idp/sdk/node-api` defines. */
export class HttpNode implements Node {
  constructor(
    readonly nodeId: number,
    readonly url: string
  ) {}

  async commit(roundId: string): Promise<Commitment> {
    const res = await this.post("/commit", z.encode(commitRequest, { roundId }), commitResponse);
    if (res.nodeId !== this.nodeId) {
      throw new Error(`node at ${this.url} answered as node ${res.nodeId}, expected ${this.nodeId}`);
    }
    return { D: res.D, E: res.E };
  }

  async signOn(request: NodeSignOnRequest): Promise<NodeSignOnResponse> {
    const { roundId, ...rest } = request;
    return this.post("/sign-on", z.encode(signOnRequest, { roundId, request: rest }), signOnResponse);
  }

  async sign(request: NodeTokenRequest): Promise<NodeTokenShares> {
    const { accessRoundId, refreshRoundId, credential, ...rest } = request;
    const credentialField = request.grant === "authorization_code" ? { assertion: credential } : { refreshToken: credential };
    const body = z.encode(signRequest, { roundId: accessRoundId, refreshRoundId, request: { ...rest, ...credentialField } });
    const res = await this.post("/sign", body, signResponse);
    return { nodeId: res.nodeId, accessShare: res.at, refreshShare: res.rt };
  }

  async health(timeoutMs = NODE_TIMEOUT_MS): Promise<NodeHealth> {
    const res = await this.request("GET", "/health", undefined, timeoutMs, healthResponse);
    return { nodeId: res.nodeId, groupPublicKey: res.groupPublicKey };
  }

  private post<T>(path: string, body: unknown, response: z.ZodType<T>): Promise<T> {
    return this.request("POST", path, body, NODE_TIMEOUT_MS, response);
  }

  /** Every failure — refused, timed out, non-2xx, malformed answer — is an Error naming the node. */
  private async request<T>(method: string, path: string, body: unknown, timeoutMs: number, response: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`node ${this.nodeId} at ${this.url} unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new Error(`node ${this.nodeId} ${path} ${res.status}: ${json.error ?? res.statusText}`);
    }
    const parsed = response.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`node ${this.nodeId} ${path} answered malformed: ${[...issue.path, issue.message].join(" ")}`);
    }
    return parsed.data;
  }
}

/**
 * `NODE_URLS` says where the nodes are, not which is which: each one reports its own id
 * from `/health`, and its group public key must be the one in group.json. Nodes still
 * starting are retried; a wrong key is not something waiting can fix.
 */
export async function discoverNodes(
  urls: string[],
  group: Group,
  attempts = 30,
  retryDelayMs = 1_000,
  log: (line: string) => void = console.log
): Promise<Node[]> {
  const found: Node[] = [];
  let missing = urls;
  for (let attempt = 1; attempt <= attempts && missing.length > 0; attempt++) {
    found.push(...(await probeNodes(missing, group, log)));
    missing = missing.filter((url) => !found.some((node) => node.url === url));
    if (missing.length > 0 && attempt < attempts) {
      log(`[gateway] waiting for ${missing.length} node(s) (attempt ${attempt}/${attempts})`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  if (missing.length > 0) {
    throw new Error(`unreachable: ${missing.join(", ")}`);
  }
  const nodes = found.sort((a, b) => a.nodeId - b.nodeId);
  if (new Set(nodes.map((n) => n.nodeId)).size !== nodes.length) {
    throw new Error("two node URLs report the same nodeId");
  }
  return nodes;
}

/** One attempt over the given urls: the nodes that answered. */
async function probeNodes(urls: string[], group: Group, log: (line: string) => void): Promise<Node[]> {
  const answers = await Promise.all(urls.map((url) => probeNode(url, group, log)));
  return answers.filter((node) => node !== undefined);
}

/** The node behind `url`, or undefined while it does not answer. A different group key is fatal. */
async function probeNode(url: string, group: Group, log: (line: string) => void): Promise<Node | undefined> {
  const health = await new HttpNode(0, url).health().catch(() => undefined);
  if (health === undefined) return undefined;
  if (bytesToHex(health.groupPublicKey) !== bytesToHex(group.groupPublicKey)) {
    throw new Error(`node at ${url} holds a different group key than group.json`);
  }
  log(`[gateway] discovered node ${health.nodeId} at ${url}`);
  return new HttpNode(health.nodeId, url);
}
