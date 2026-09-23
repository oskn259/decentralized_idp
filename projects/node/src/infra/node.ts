import fs from "node:fs";
import { User } from "../domain/entity/user.js";
import { Clock } from "../domain/infra/clock.js";
import { RoundStore } from "../domain/infra/round-store.js";
import { UserRepository } from "../domain/repository/user-repository.js";
import { IdentityNode } from "../domain/usecase/identity-node.js";
import { DEFAULT_KEY_ID } from "../domain/value/node-identity.js";
import { FrostNonces } from "@decentralized-idp/sdk/frost";
import { hexToBigInt, hexToBytes } from "@decentralized-idp/sdk/hex";

// ---- the dealer's file ------------------------------------------------------

/** `node-<id>.json`. Byte strings and scalars are lowercase hex; scalars are 64 digits, big-endian. */
interface NodeConfigFile {
  nodeId: number;
  threshold: number;
  total: number;
  groupPublicKey: string;
  secretKeyShare: string;
  users: Array<{
    username: string;
    sub: string;
    toprfKeyShare: { id: number; value: string };
    h_i: string;
  }>;
}

export interface NodeConfig {
  nodeId: number;
  threshold: number;
  total: number;
  groupPublicKey: Uint8Array;
  secretKeyShare: bigint;
  users: User[];
}

export function loadNodeConfig(path: string): NodeConfig {
  return parseNodeConfig(fs.readFileSync(path, "utf8"));
}

function userOf(user: NodeConfigFile["users"][number], nodeId: number): User {
  // A share dealt for another node would evaluate the TOPRF wrongly without any error.
  if (user.toprfKeyShare.id !== nodeId) {
    throw new Error(`user ${user.username}: toprfKeyShare.id ${user.toprfKeyShare.id} is not this node's id ${nodeId}`);
  }
  return {
    username: user.username,
    sub: user.sub,
    toprfKeyShare: { id: user.toprfKeyShare.id, value: hexToBigInt(user.toprfKeyShare.value) },
    h_i: hexToBytes(user.h_i),
  };
}

export function parseNodeConfig(text: string): NodeConfig {
  const file = JSON.parse(text) as NodeConfigFile;
  return {
    nodeId: file.nodeId,
    threshold: file.threshold,
    total: file.total,
    groupPublicKey: hexToBytes(file.groupPublicKey),
    secretKeyShare: hexToBigInt(file.secretKeyShare),
    users: file.users.map((user) => userOf(user, file.nodeId)),
  };
}

// ---- in-process implementations of the domain interfaces --------------------

/** Users are dealt before start-up and never change while the node runs. */
export class InMemoryUserRepository implements UserRepository {
  private readonly users: Map<string, User>;

  constructor(users: User[]) {
    this.users = new Map(users.map((user) => [user.username, user]));
  }

  findByUsername(username: string): User | undefined {
    return this.users.get(username);
  }
}

export class InMemoryRoundStore implements RoundStore {
  private readonly nonces = new Map<string, FrostNonces>();

  open(roundId: string, nonces: FrostNonces): void {
    this.nonces.set(roundId, nonces);
  }

  take(roundId: string): FrostNonces | undefined {
    const nonces = this.nonces.get(roundId);
    this.nonces.delete(roundId);
    return nonces;
  }
}

export const systemClock: Clock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
};

// ---- assembly ----------------------------------------------------------------

export function nodeFromConfig(config: NodeConfig, issuer: string): IdentityNode {
  return {
    identity: {
      nodeId: config.nodeId,
      secretKeyShare: config.secretKeyShare,
      groupPublicKey: config.groupPublicKey,
      issuer,
      keyId: DEFAULT_KEY_ID,
    },
    users: new InMemoryUserRepository(config.users),
    rounds: new InMemoryRoundStore(),
    clock: systemClock,
  };
}
