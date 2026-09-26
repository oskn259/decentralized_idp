import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, utf8 } from "./bytes.js";

/**
 * A sealed box: bytes only the holder of one X25519 secret key can read. The sender uses
 * a fresh ephemeral key per box, so the AEAD key is never reused and the nonce can be
 * fixed. The browser seals a user's shares to each node; the gateway relays them unread.
 *
 *   key   = HKDF-SHA256( x25519(esk, pk), salt = "", info = "PASTA-SEAL" ‖ epk ‖ pk )[0..32]
 *   box   = epk ‖ ChaCha20-Poly1305( key, nonce = 12 zero bytes, plaintext, aad )
 */

export interface SealingKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface SealedBox {
  ephemeralPublicKey: Uint8Array;
  ciphertext: Uint8Array;
}

const NONCE = new Uint8Array(12);

export function generateSealingKeyPair(): SealingKeyPair {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function sealingPublicKeyOf(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey);
}

function boxKey(ephemeralPublicKey: Uint8Array, recipientPublicKey: Uint8Array, shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, undefined, concatBytes(utf8("PASTA-SEAL"), ephemeralPublicKey, recipientPublicKey), 32);
}

/** `ephemeralSecretKey` is drawn fresh unless a test vector pins it. */
export function seal(recipientPublicKey: Uint8Array, plaintext: Uint8Array, aad: Uint8Array, ephemeralSecretKey = x25519.utils.randomPrivateKey()): SealedBox {
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralSecretKey);
  const key = boxKey(ephemeralPublicKey, recipientPublicKey, x25519.getSharedSecret(ephemeralSecretKey, recipientPublicKey));
  return { ephemeralPublicKey, ciphertext: chacha20poly1305(key, NONCE, aad).encrypt(plaintext) };
}

/** Throws when the tag does not verify: another recipient, altered AAD or ciphertext. */
export function open(secretKey: Uint8Array, box: SealedBox, aad: Uint8Array): Uint8Array {
  const key = boxKey(box.ephemeralPublicKey, x25519.getPublicKey(secretKey), x25519.getSharedSecret(secretKey, box.ephemeralPublicKey));
  return chacha20poly1305(key, NONCE, aad).decrypt(box.ciphertext);
}
