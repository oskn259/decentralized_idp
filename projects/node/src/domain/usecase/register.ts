import { IdentityNode } from "./identity-node.js";

export interface RegisterInput {
  username: string;
  /** Chosen by the browser; stored as given. */
  sub: string;
  /** k_i */
  toprfKeyShare: bigint;
  /** h_i = H(h, i) */
  h_i: Uint8Array;
}

/** Stores this node's share of a new user, as the browser sent it. The password never reaches the node. */
export function register(node: IdentityNode, { username, sub, toprfKeyShare, h_i }: RegisterInput): void {
  node.users.insert({ username, sub, toprfKeyShare: { id: node.identity.nodeId, value: toprfKeyShare }, h_i });
}
