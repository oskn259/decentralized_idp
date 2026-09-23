import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes, u16ToBytesLE, utf8 } from "./bytes.js";

/**
 * ChaCha20-Poly1305 with the signing input as AAD: a share decrypts only against the
 * exact assertion bytes it was computed for. The node encrypts; the browser decrypts.
 */

/** nonce = SHA-512("PASTA-AEAD-NONCE" ‖ sessionNonce ‖ id)[0..12]. Both sides derive it; it is never sent. */
export function deriveAeadNonce(sessionNonce: Uint8Array, id: number): Uint8Array {
  return sha512(concatBytes(utf8("PASTA-AEAD-NONCE"), sessionNonce, u16ToBytesLE(id))).slice(0, 12);
}

export function aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

/** Throws when the tag does not verify: wrong key (wrong password), altered AAD or ciphertext. */
export function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}
