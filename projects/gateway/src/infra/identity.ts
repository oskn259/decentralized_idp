import fs from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { base64UrlDecode } from "@decentralized-idp/sdk/base64url";
import { assembleJwt, createSigningInput } from "@decentralized-idp/sdk/jwt";

/** Who the gateway is to the nodes: the client it authenticates as at `/sign`, and the wallet it pays from. */
export interface GatewayIdentity {
  clientId: string;
  keyId: string;
  /** Ed25519 private key, 32 bytes. */
  signingKey: Uint8Array;
  wallet: { address: `0x${string}`; privateKey: `0x${string}` };
}

/** What distKey writes: `{ client_id, key: <private Ed25519 JWK>, wallet }`. */
interface IdentityFile {
  client_id: string;
  key: { kty?: string; crv?: string; d?: string; kid?: string };
  wallet: { address: `0x${string}`; privateKey: `0x${string}` };
}

export function loadIdentity(path: string): GatewayIdentity {
  const file = JSON.parse(fs.readFileSync(path, "utf8")) as IdentityFile;
  const signingKey = file.key.kty === "OKP" && file.key.crv === "Ed25519" && file.key.d ? base64UrlDecode(file.key.d) : new Uint8Array();
  if (signingKey.length !== 32) throw new Error(`${path} has no private OKP Ed25519 key`);
  return { clientId: file.client_id, keyId: file.key.kid ?? "", signingKey, wallet: file.wallet };
}

/** The gateway's `private_key_jwt` (RFC 7523) for one node: `aud` is that node's public URL. */
export function signClientAssertion(identity: GatewayIdentity, aud: string, now: number): string {
  const { signingInput, headerB64, payloadB64 } = createSigningInput({
    header: { alg: "EdDSA", kid: identity.keyId },
    payload: { iss: identity.clientId, sub: identity.clientId, aud, jti: crypto.randomUUID(), iat: now, exp: now + 60 },
  });
  return assembleJwt(headerB64, payloadB64, ed25519.sign(signingInput, identity.signingKey));
}
