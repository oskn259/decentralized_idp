import { SealedBox } from "@decentralized-idp/sdk/seal";
import { Node } from "../infra/node.js";
import { Gateway } from "./gateway.js";

export { UsernameTakenError } from "../infra/node.js";

/** What the browser sends: one share per node, each sealed to that node's key. */
export interface RegisterRequest {
  username: string;
  shares: { nodeId: number; share: SealedBox }[];
}

/**
 * Relays a new user's shares. The gateway assigns `sub` and hands each node its own
 * sealed share, which it cannot open. Every node must accept, or the registration
 * fails with the first node's refusal. Nothing is kept here.
 */
export async function register(gateway: Gateway, request: RegisterRequest): Promise<{ sub: string }> {
  checkOneSharePerNode(gateway.nodes, request.shares);
  const sub = crypto.randomUUID();
  await Promise.all(
    gateway.nodes.map((node) =>
      node.register({ username: request.username, sub, share: request.shares.find((s) => s.nodeId === node.nodeId)!.share })
    )
  );
  return { sub };
}

/** Exactly one share for every node, and none for a node the gateway does not know. */
function checkOneSharePerNode(nodes: Node[], shares: RegisterRequest["shares"]): void {
  const known = nodes.map((node) => node.nodeId);
  const given = shares.map((s) => s.nodeId);
  const missing = known.filter((id) => !given.includes(id));
  const unknown = given.filter((id) => !known.includes(id));
  const repeated = given.filter((id, i) => given.indexOf(id) !== i);
  if (missing.length > 0) throw new Error(`no share for node ${missing.join(", ")}`);
  if (unknown.length > 0) throw new Error(`no such node: ${unknown.join(", ")}`);
  if (repeated.length > 0) throw new Error(`more than one share for node ${repeated.join(", ")}`);
}
