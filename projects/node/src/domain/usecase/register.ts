import { SealedBox } from "@decentralized-idp/sdk/seal";
import { UserShare, openUserShare } from "@decentralized-idp/sdk/register";
import { IdentityNode } from "./identity-node.js";

export interface RegisterInput {
  username: string;
  /** Assigned by the gateway; stored as given. */
  sub: string;
  /** `{ k_i, h_i }` sealed by the browser to this node under this username. */
  share: SealedBox;
}

/** Opens this node's share of a new user and stores it. The password never reaches the node. */
export function register(node: IdentityNode, { username, sub, share }: RegisterInput): void {
  const { toprfKeyShare, h_i } = openShare(node, share, username);
  node.users.insert({ username, sub, toprfKeyShare, h_i });
}

function openShare(node: IdentityNode, share: SealedBox, username: string): UserShare {
  const { nodeId, sealingSecretKey } = node.identity;
  try {
    return openUserShare(sealingSecretKey, share, nodeId, username);
  } catch {
    throw new Error(`share was not sealed for node ${nodeId} and username ${username}`);
  }
}
