import { publicKeyOf } from "@decentralized-idp/sdk/frost";
import { randomScalar } from "@decentralized-idp/sdk/scalar";
import { Share, splitSecret } from "@decentralized-idp/sdk/shamir";
import { blind, deriveServerKey, evaluate, finalize, unblind } from "@decentralized-idp/sdk/toprf";

/** A user to register with every node. The password is used once, to derive h, and never stored. */
export interface UserSpec {
  username: string;
  password: string;
  sub: string;
}

/** What node i holds about one user: its TOPRF share k_i and h_i, the key node i uses to encrypt this user's shares at sign-on. */
export interface NodeUser {
  username: string;
  sub: string;
  toprfKeyShare: Share;
  h_i: Uint8Array;
}

export interface NodeKeys {
  nodeId: number;
  /** s_i */
  secretKeyShare: bigint;
  users: NodeUser[];
}

export interface DistributedKeys {
  threshold: number;
  total: number;
  /** Y = s·B, the key every token is verified against. */
  groupPublicKey: Uint8Array;
  nodes: NodeKeys[];
}

/**
 * The trusted dealer's one job: one group signing key split t-of-n (node i gets s_i, everyone
 * gets Y), and every user registered with every node. The dealer is the only party that sees
 * the whole group key, every share and every password.
 */
export function distributeKeys(threshold: number, total: number, users: UserSpec[]): DistributedKeys {
  const names = users.map((u) => u.username);
  if (new Set(names).size !== names.length) {
    throw new Error("duplicate username");
  }

  const groupSecret = randomScalar();
  const signingShares = splitSecret(groupSecret, threshold, total);
  const recordsPerUser = users.map((user) => registerUser(user, threshold, total));
  const usersOnNode = (nodeId: number): NodeUser[] =>
    recordsPerUser.map((userRecords) => userRecords.find((record) => record.toprfKeyShare.id === nodeId)!);

  const nodes = signingShares.map((share) => ({
    nodeId: share.id,
    secretKeyShare: share.value,
    users: usersOnNode(share.id),
  }));
  return { threshold, total, groupPublicKey: publicKeyOf(groupSecret), nodes };
}

/**
 * One user's record for each node: an independent TOPRF key split t-of-n, and h_i = H(h, i)
 * where h is derived exactly as the browser derives it at sign-on. Node i never sees h.
 */
function registerUser(user: UserSpec, threshold: number, total: number): NodeUser[] {
  const shares = splitSecret(randomScalar(), threshold, total);
  // Any t shares give the same h; the first t are as good as any.
  const h = masterKeyOf(user.password, shares.slice(0, threshold));
  return shares.map((share) => ({
    username: user.username,
    sub: user.sub,
    toprfKeyShare: share,
    h_i: deriveServerKey(h, share.id),
  }));
}

/** h, the way the browser computes it: blind, let t nodes evaluate, unblind, finalize. */
function masterKeyOf(password: string, shares: Share[]): Uint8Array {
  const { blinding, blinded } = blind(password);
  const partials = shares.map((share) => ({ id: share.id, point: evaluate(share, blinded) }));
  return finalize(password, unblind(blinding, partials));
}
