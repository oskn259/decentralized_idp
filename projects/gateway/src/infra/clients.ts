import fs from "node:fs";
import { base64UrlDecode } from "@decentralized-idp/sdk/base64url";
import { Client } from "../domain/value/client.js";

/** What distKey writes: each client with its JWK Set (RFC 7517). */
interface ClientsFile {
  version: number;
  clients: ClientEntry[];
}

interface ClientEntry {
  client_id: string;
  jwks: { keys: Array<{ kty?: string; crv?: string; x?: string }> };
}

export function parseClients(text: string): Client[] {
  const file = JSON.parse(text) as ClientsFile;
  return file.clients.map(clientOf);
}

export function loadClients(path: string): Client[] {
  return parseClients(fs.readFileSync(path, "utf8"));
}

/** The first Ed25519 key of the client's JWKS; a client without one cannot authenticate. */
function clientOf(entry: ClientEntry): Client {
  const key = entry.jwks.keys.find((k) => k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string");
  const publicKey = key ? base64UrlDecode(key.x!) : new Uint8Array();
  if (publicKey.length !== 32) {
    throw new Error(`client ${entry.client_id} has no OKP Ed25519 key in clients.json`);
  }
  return { clientId: entry.client_id, publicKey };
}
