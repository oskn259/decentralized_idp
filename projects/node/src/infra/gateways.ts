import fs from "node:fs";
import { base64UrlDecode } from "@decentralized-idp/sdk/base64url";
import { Gateway } from "../domain/value/gateway.js";

/** `gateways.json`, as distKey writes it: each gateway with its JWK Set (RFC 7517). */
interface GatewaysFile {
  version: number;
  clients: GatewayEntry[];
}

interface GatewayEntry {
  client_id: string;
  jwks: { keys: Array<{ kty?: string; crv?: string; x?: string }> };
}

export function parseGateways(text: string): Gateway[] {
  const file = JSON.parse(text) as GatewaysFile;
  return file.clients.map(gatewayOf);
}

export function loadGateways(path: string): Gateway[] {
  return parseGateways(fs.readFileSync(path, "utf8"));
}

/** The first Ed25519 key of the gateway's JWKS; a gateway without one cannot authenticate. */
function gatewayOf(entry: GatewayEntry): Gateway {
  const key = entry.jwks.keys.find((k) => k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string");
  const publicKey = key ? base64UrlDecode(key.x!) : new Uint8Array();
  if (publicKey.length !== 32) {
    throw new Error(`gateway ${entry.client_id} has no OKP Ed25519 key in gateways.json`);
  }
  return { clientId: entry.client_id, publicKey };
}
