const HEX = /^[0-9a-fA-F]*$/;

export function hexToBytes(hex: string): Uint8Array {
  if (!HEX.test(hex) || hex.length % 2 !== 0) {
    throw new Error("not a hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Big-endian hex of any length -> bigint. This is not the little-endian byte encoding Ed25519 signatures use. */
export function hexToBigInt(hex: string): bigint {
  if (!HEX.test(hex) || hex.length === 0) {
    throw new Error("not a hex string");
  }
  return BigInt("0x" + hex);
}

/** Scalars in key files and on the wire are 64 hex digits, big-endian, zero padded. */
export function bigIntToHex(value: bigint, digits = 64): string {
  return value.toString(16).padStart(digits, "0");
}
