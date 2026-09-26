import fs from "node:fs";
import path from "node:path";
import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { exportDPoPJwk } from "@decentralized-idp/sdk/dpop";
import { bigIntToHex, bytesToHex } from "@decentralized-idp/sdk/hex";
import { ClientKeys, DistributedKeys, NodeKeys } from "../domain/usecase/distribute-keys.js";

// File formats: protocol/README.md, 鍵ファイル; clients.json and client-<id>.json: gateway and rp READMEs.

/**
 * `kid` of the group key in every JWT header; the gateway publishes the key under it.
 * Must equal DEFAULT_KEY_ID in projects/node/src/domain/value/node-identity.ts: the node
 * signs with its own copy, and node-<id>.json does not carry it.
 */
export const KEY_ID = "pasta-group-key-1";

const GROUP_FILE = "group.json";
const CLIENTS_FILE = "clients.json";

function nodeFileName(nodeId: number): string {
  return `node-${nodeId}.json`;
}

function clientFileName(clientId: string): string {
  return `client-${clientId}.json`;
}

export function outputFileNames(total: number, clientIds: string[]): string[] {
  return [GROUP_FILE, ...Array.from({ length: total }, (_, i) => nodeFileName(i + 1)), CLIENTS_FILE, ...clientIds.map(clientFileName)];
}

export interface OutputFile {
  name: string;
  content: string;
}

export function outputFiles(keys: DistributedKeys): OutputFile[] {
  return [groupFile(keys), ...keys.nodes.map((node) => nodeFile(keys, node)), clientsFile(keys), ...keys.clients.map(clientFile)];
}

function keyId(client: ClientKeys): string {
  return `${client.clientId}-key-1`;
}

/** Read by the gateway: every relying party's public key, for `private_key_jwt`. */
function clientsFile(keys: DistributedKeys): OutputFile {
  return {
    name: CLIENTS_FILE,
    content: json({
      version: 1,
      clients: keys.clients.map((client) => ({
        client_id: client.clientId,
        jwks: { keys: [{ ...exportDPoPJwk(client.keyPair.publicKey), kid: keyId(client), use: "sig", alg: "EdDSA" }] },
      })),
    }),
  };
}

/** Read by that relying party: its private key as a JWK. */
function clientFile(client: ClientKeys): OutputFile {
  return {
    name: clientFileName(client.clientId),
    content: json({
      client_id: client.clientId,
      key: { ...exportDPoPJwk(client.keyPair.publicKey), d: base64UrlEncode(client.keyPair.privateKey), kid: keyId(client) },
    }),
  };
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
      version: 2,
      nodeId: node.nodeId,
      threshold: keys.threshold,
      total: keys.total,
      groupPublicKey: bytesToHex(keys.groupPublicKey),
      secretKeyShare: bigIntToHex(node.secretKeyShare),
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
