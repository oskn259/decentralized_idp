import fs from "node:fs";
import path from "node:path";
import { bigIntToHex, bytesToHex } from "@decentralized-idp/sdk/hex";
import { DistributedKeys, NodeKeys } from "../domain/usecase/distribute-keys.js";

// File formats: protocol/README.md, 鍵ファイル.

/**
 * `kid` of the group key in every JWT header; the gateway publishes the key under it.
 * Must equal DEFAULT_KEY_ID in projects/node/src/domain/value/node-identity.ts: the node
 * signs with its own copy, and node-<id>.json does not carry it.
 */
export const KEY_ID = "pasta-group-key-1";

const GROUP_FILE = "group.json";

function nodeFileName(nodeId: number): string {
  return `node-${nodeId}.json`;
}

export function outputFileNames(total: number): string[] {
  return [GROUP_FILE, ...Array.from({ length: total }, (_, i) => nodeFileName(i + 1))];
}

export interface OutputFile {
  name: string;
  content: string;
}

export function outputFiles(keys: DistributedKeys): OutputFile[] {
  return [groupFile(keys), ...keys.nodes.map((node) => nodeFile(keys, node))];
}

/** Read by the gateway. */
function groupFile(keys: DistributedKeys): OutputFile {
  return {
    name: GROUP_FILE,
    content: json({
      version: 1,
      threshold: keys.threshold,
      total: keys.total,
      keyId: KEY_ID,
      groupPublicKey: bytesToHex(keys.groupPublicKey),
    }),
  };
}

/** Read by node `node.nodeId`. */
function nodeFile(keys: DistributedKeys, node: NodeKeys): OutputFile {
  return {
    name: nodeFileName(node.nodeId),
    content: json({
      version: 1,
      nodeId: node.nodeId,
      threshold: keys.threshold,
      total: keys.total,
      groupPublicKey: bytesToHex(keys.groupPublicKey),
      secretKeyShare: bigIntToHex(node.secretKeyShare),
      users: node.users.map((user) => ({
        username: user.username,
        sub: user.sub,
        toprfKeyShare: { id: user.toprfKeyShare.id, value: bigIntToHex(user.toprfKeyShare.value) },
        h_i: bytesToHex(user.h_i),
      })),
    }),
  };
}

type ExistingFiles = "none" | "all" | "some";

export function existingOutputFiles(dir: string, names: string[]): ExistingFiles {
  const present = names.filter((name) => fs.existsSync(path.join(dir, name))).length;
  if (present === 0) return "none";
  if (present === names.length) return "all";
  return "some";
}

export function writeOutputFiles(dir: string, files: OutputFile[]): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(dir, file.name), file.content);
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
