import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base64UrlDecode, base64UrlEncode } from "./base64url.js";
import { utf8 } from "./bytes.js";
import { assembleJwt, createSigningInput, decodeJwt, deterministicJsonStringify, verifyJwt } from "./jwt.js";

/** RFC 9449 DPoP with Ed25519 keys. The rp creates proofs; gateway and nodes verify them. */

export interface DPoPKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface DPoPJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export function generateDPoPKeyPair(): DPoPKeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  return { publicKey: ed25519.getPublicKey(privateKey), privateKey };
}

export function exportDPoPJwk(publicKey: Uint8Array): DPoPJwk {
  return { kty: "OKP", crv: "Ed25519", x: base64UrlEncode(publicKey) };
}

/** RFC 7638 thumbprint: SHA-256 of `{"crv","kty","x"}` in that order, base64url. */
export function calculateJwkThumbprint(jwk: DPoPJwk): string {
  const canonical = deterministicJsonStringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return base64UrlEncode(sha256(utf8(canonical)));
}

export function createDPoPProof(keyPair: DPoPKeyPair, htm: string, htu: string, iat: number): string {
  const { signingInput, headerB64, payloadB64 } = createSigningInput({
    header: { typ: "dpop+jwt", alg: "EdDSA", jwk: exportDPoPJwk(keyPair.publicKey) },
    payload: { jti: crypto.randomUUID(), htm: htm.toUpperCase(), htu, iat },
  });
  return assembleJwt(headerB64, payloadB64, ed25519.sign(signingInput, keyPair.privateKey));
}

export interface DPoPExpectation {
  htm: string;
  htu: string;
  /** Thumbprint the proof's key must have: the `cnf.jkt` of the credential being spent. */
  jkt: string;
  now: number;
  maxAgeSeconds: number;
}

/** RFC 9449 §4.3. Throws with the first failing check; returns the accepted proof's `jti`. */
export function verifyDPoPProof(proof: string, expected: DPoPExpectation): { jti: string } {
  const jwk = readJwk(proof);
  const { header, payload } = verifyJwt(proof, base64UrlDecode(jwk.x));

  if (header.typ !== "dpop+jwt") {
    throw new Error(`Invalid typ: ${String(header.typ)}, expected 'dpop+jwt'`);
  }
  if (typeof payload.htm !== "string" || payload.htm.toUpperCase() !== expected.htm.toUpperCase()) {
    throw new Error(`htm mismatch: expected ${expected.htm}, got ${String(payload.htm)}`);
  }
  if (payload.htu !== expected.htu) {
    throw new Error(`htu mismatch: expected ${expected.htu}, got ${String(payload.htu)}`);
  }
  if (typeof payload.iat !== "number" || Math.abs(expected.now - payload.iat) > expected.maxAgeSeconds) {
    throw new Error("DPoP proof timestamp expired or out of allowed window");
  }
  const jkt = calculateJwkThumbprint(jwk);
  if (jkt !== expected.jkt) {
    throw new Error(`DPoP thumbprint mismatch: expected ${expected.jkt}, got ${jkt}`);
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new Error("DPoP proof has no jti");
  }
  return { jti: payload.jti };
}

/** The signing key travels in the header; it must be a 32-byte Ed25519 OKP key. */
function readJwk(proof: string): DPoPJwk {
  let header: Record<string, unknown>;
  try {
    header = decodeJwt(proof).header;
  } catch {
    throw new Error("Invalid DPoP proof JWT format");
  }
  const jwk = header.jwk as Partial<DPoPJwk> | undefined;
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("Invalid or missing OKP/Ed25519 jwk in header");
  }
  if (base64UrlDecode(jwk.x).length !== 32) {
    throw new Error("Invalid public key length in jwk");
  }
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}
