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
  sealingSecretKey?: string;
}

export interface NodeConfig {
  nodeId: number;
  threshold: number;
  total: number;
  groupPublicKey: Uint8Array;
  secretKeyShare: bigint;
  sealingSecretKey: Uint8Array;
}

export function loadNodeConfig(path: string): NodeConfig {
  return parseNodeConfig(fs.readFileSync(path, "utf8"));
}

function sealingSecretKeyOf(hex: string | undefined): Uint8Array {
  if (hex === undefined) {
    throw new Error("sealingSecretKey is missing: the node reads a version 2 node-<id>.json");
  }
  const key = hexToBytes(hex);
  if (key.length !== 32) {
    throw new Error(`sealingSecretKey must be 32 bytes, got ${key.length}`);
  }
  return key;
}

export function parseNodeConfig(text: string): NodeConfig {
  const file = JSON.parse(text) as NodeConfigFile;
  return {
    nodeId: file.nodeId,
    threshold: file.threshold,
    total: file.total,
    groupPublicKey: hexToBytes(file.groupPublicKey),
    secretKeyShare: hexToBigInt(file.secretKeyShare),
    sealingSecretKey: sealingSecretKeyOf(file.sealingSecretKey),
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

/** `usersFile` holds the users registered so far; it is created on the first registration. */
export function nodeFromConfig(config: NodeConfig, issuer: string, usersFile: string): IdentityNode {
  return {
    identity: {
      nodeId: config.nodeId,
      secretKeyShare: config.secretKeyShare,
      groupPublicKey: config.groupPublicKey,
      sealingSecretKey: config.sealingSecretKey,
      issuer,
      keyId: DEFAULT_KEY_ID,
    },
    users: new FileUserRepository(usersFile),
    rounds: new InMemoryRoundStore(),
    clock: systemClock,
  };
}
