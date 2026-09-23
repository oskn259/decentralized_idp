import { base64UrlDecode, base64UrlDecodeText, base64UrlEncode } from "./base64url.js";
import { utf8 } from "./bytes.js";
import { verifySignature } from "./frost.js";

/** An unsigned JWT: what every signer must serialize to byte-identical signing input. */
export interface Jwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/**
 * JSON with keys sorted at every level and `undefined` members left out. Every node and
 * the client serialize the same claims independently; the signature only aggregates if
 * they all produce the same bytes.
 */
export function deterministicJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(deterministicJsonStringify).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => JSON.stringify(key) + ":" + deterministicJsonStringify(record[key]));
  return "{" + members.join(",") + "}";
}

/** `base64url(header).base64url(payload)`, the bytes an EdDSA signature covers. */
export function createSigningInput(jwt: Jwt): { signingInput: Uint8Array; headerB64: string; payloadB64: string } {
  const headerB64 = base64UrlEncode(deterministicJsonStringify(jwt.header));
  const payloadB64 = base64UrlEncode(deterministicJsonStringify(jwt.payload));
  return { signingInput: utf8(`${headerB64}.${payloadB64}`), headerB64, payloadB64 };
}

export function assembleJwt(headerB64: string, payloadB64: string, signature: Uint8Array): string {
  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

/** The decoded parts of a JWT, signature unchecked. For reading claims before relaying. */
export function decodeJwt(token: string): Jwt {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT: expected 3 parts");
  }
  return { header: parseJson(parts[0]), payload: parseJson(parts[1]) };
}

/** Checks `alg: EdDSA` and the Ed25519 signature, and returns the decoded parts. Throws otherwise. */
export function verifyJwt(token: string, publicKey: Uint8Array): Jwt {
  const { header, payload } = decodeJwt(token);
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (header.alg !== "EdDSA") {
    throw new Error(`Unsupported alg: ${String(header.alg)}`);
  }
  if (!verifySignature(base64UrlDecode(signatureB64), utf8(`${headerB64}.${payloadB64}`), publicKey)) {
    throw new Error("Invalid Ed25519 signature");
  }
  return { header, payload };
}

function parseJson(segmentB64: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(base64UrlDecodeText(segmentB64));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Malformed JWT: segment is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}
