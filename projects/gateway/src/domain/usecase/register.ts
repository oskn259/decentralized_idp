import { SealedBox } from "@decentralized-idp/sdk/seal";
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
  const shares = new Map(request.shares.map((s) => [s.nodeId, s.share]));
  const missing = gateway.nodes.filter((node) => !shares.has(node.nodeId)).map((node) => node.nodeId);
  if (missing.length > 0) {
    throw new Error(`no share for node ${missing.join(", ")}`);
  }
  const sub = crypto.randomUUID();
  await Promise.all(gateway.nodes.map((node) => node.register({ username: request.username, sub, share: shares.get(node.nodeId)! })));
  return { sub };
}
