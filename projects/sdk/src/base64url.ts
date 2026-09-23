const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VALUE = new Map([...ALPHABET].map((char, i) => [char, i]));

/** base64url without padding, the encoding of every byte string on the HTTP wire. Runs in Node and in the browser. */
export function base64UrlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    // n leftover bytes encode to n + 1 characters.
    const chars = 1 + Math.min(3, bytes.length - i);
    for (let k = 0; k < chars; k++) {
      out += ALPHABET[(chunk >> (18 - 6 * k)) & 63];
    }
  }
  return out;
}

/** Refuses characters outside the alphabet and lengths no byte string can produce. */
export function base64UrlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) {
    throw new Error("not a base64url string");
  }
  const values = [...text].map(valueOf);
  const out = new Uint8Array(Math.floor((values.length * 3) / 4));
  let n = 0;
  for (let i = 0; i < values.length; i += 4) {
    const chunk = (values[i] << 18) | ((values[i + 1] ?? 0) << 12) | ((values[i + 2] ?? 0) << 6) | (values[i + 3] ?? 0);
    // n leftover characters decode to n - 1 bytes.
    const bytes = Math.min(3, values.length - i - 1);
    for (let k = 0; k < bytes; k++) {
      out[n++] = (chunk >> (16 - 8 * k)) & 255;
    }
  }
  return out;
}

export function base64UrlDecodeText(text: string): string {
  return new TextDecoder().decode(base64UrlDecode(text));
}

function valueOf(char: string): number {
  const value = VALUE.get(char);
  if (value === undefined) {
    throw new Error("not a base64url string");
  }
  return value;
}
