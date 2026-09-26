import fs from "node:fs";
import { Clock } from "../domain/infra/clock.js";
import { RoundStore } from "../domain/infra/round-store.js";
import { IdentityNode } from "../domain/usecase/identity-node.js";
import { DEFAULT_KEY_ID } from "../domain/value/node-identity.js";
import { FileUserRepository } from "./user-store.js";
import { FrostNonces } from "@decentralized-idp/sdk/frost";
import { hexToBigInt, hexToBytes } from "@decentralized-idp/sdk/hex";

// ---- the dealer's file ------------------------------------------------------

/** `node-<id>.json`, version 2. Byte strings and scalars are lowercase hex; scalars are 64 digits, big-endian. */
interface NodeConfigFile {
  nodeId: number;
  threshold: number;
  total: number;
  groupPublicKey: string;
  secretKeyShare: string;
}

export interface NodeConfig {
  nodeId: number;
  threshold: number;
  total: number;
  groupPublicKey: Uint8Array;
  secretKeyShare: bigint;
}

export function loadNodeConfig(path: string): NodeConfig {
  return parseNodeConfig(fs.readFileSync(path, "utf8"));
}

export function parseNodeConfig(text: string): NodeConfig {
  const file = JSON.parse(text) as NodeConfigFile;
  return {
    nodeId: file.nodeId,
    threshold: file.threshold,
    total: file.total,
    groupPublicKey: hexToBytes(file.groupPublicKey),
    secretKeyShare: hexToBigInt(file.secretKeyShare),
  };
}

// ---- in-process implementations of the domain interfaces --------------------

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

export interface NodeOptions {
  issuer: string;
  publicUrl: string;
  /** The users registered so far; created on the first registration. */
  usersFile: string;
}

export function nodeFromConfig(config: NodeConfig, { issuer, publicUrl, usersFile }: NodeOptions): IdentityNode {
  return {
    identity: {
      nodeId: config.nodeId,
      secretKeyShare: config.secretKeyShare,
      groupPublicKey: config.groupPublicKey,
      issuer,
      publicUrl,
      keyId: DEFAULT_KEY_ID,
    },
    users: new FileUserRepository(usersFile),
    rounds: new InMemoryRoundStore(),
    clock: systemClock,
  };
}
