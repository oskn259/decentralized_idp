import { ed25519 } from "@noble/curves/ed25519";

/** Order of the Ed25519 prime-order subgroup. Every scalar in the protocol lives in Z_L. */
export const L: bigint = ed25519.CURVE.n;

export function mod(a: bigint): bigint {
  const r = a % L;
  return r >= 0n ? r : r + L;
}

/** a^(L-2) mod L by Fermat's little theorem, computed by square-and-multiply. */
export function invert(a: bigint): bigint {
  let base = mod(a);
  if (base === 0n) {
    throw new Error("Zero has no modular inverse");
  }
  let result = 1n;
  let exponent = L - 2n;
  while (exponent > 0n) {
    if ((exponent & 1n) === 1n) {
      result = mod(result * base);
    }
    base = mod(base * base);
    exponent >>= 1n;
  }
  return result;
}

/** Little-endian bytes -> scalar, the encoding Ed25519 signatures use. */
export function scalarFromBytesLE(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    acc = (acc << 8n) | BigInt(bytes[i]);
  }
  return mod(acc);
}

export function scalarToBytesLE(scalar: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let rest = mod(scalar);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** Uniform random scalar: 64 bytes of OS entropy reduced mod L. */
export function randomScalar(): bigint {
  const bytes = new Uint8Array(64);
  globalThis.crypto.getRandomValues(bytes);
  return scalarFromBytesLE(bytes);
}
