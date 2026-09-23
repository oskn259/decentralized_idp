import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlDecodeText, base64UrlEncode } from "../src/base64url.js";
import { bigIntToHex, bytesToHex, hexToBigInt, hexToBytes } from "../src/hex.js";

describe("hex", () => {
  it("round-trips bytes through hexToBytes/bytesToHex, zero-padding each byte", () => {
    const bytes = Uint8Array.of(0, 1, 15, 16, 255);
    const hex = bytesToHex(bytes);
    expect(hex).toBe("00010f10ff");
    expect(hexToBytes(hex)).toEqual(bytes);
  });

  it("hexToBytes rejects non-hex characters and odd length", () => {
    expect(() => hexToBytes("zz")).toThrowError(/not a hex string/);
    expect(() => hexToBytes("abc")).toThrowError(/not a hex string/);
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
  });

  it("hexToBigInt/bigIntToHex round-trip big-endian, zero-padded to 64 digits by default", () => {
    const value = 0x1234abcdn;
    const hex = bigIntToHex(value);
    expect(hex).toHaveLength(64);
    expect(hex.endsWith("1234abcd")).toBe(true);
    expect(hexToBigInt(hex)).toBe(value);
    expect(hexToBigInt("1234ABCD")).toBe(value);
  });

  it("bigIntToHex accepts an explicit digit width", () => {
    expect(bigIntToHex(255n, 4)).toBe("00ff");
  });

  it("hexToBigInt rejects non-hex characters and the empty string", () => {
    expect(() => hexToBigInt("xyz")).toThrowError(/not a hex string/);
    expect(() => hexToBigInt("")).toThrowError(/not a hex string/);
  });
});

describe("base64url", () => {
  it("round-trips bytes and text without padding", () => {
    const bytes = Uint8Array.of(0xff, 0x00, 0x10);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(encoded)).toEqual(bytes);

    const text = base64UrlEncode("hello world");
    expect(base64UrlDecodeText(text)).toBe("hello world");
  });

  it("rejects characters outside the base64url alphabet", () => {
    expect(() => base64UrlDecode("not valid!")).toThrowError(/not a base64url string/);
    expect(() => base64UrlDecode("has+plus")).toThrowError(/not a base64url string/);
    expect(() => base64UrlDecode("has=padding")).toThrowError(/not a base64url string/);
  });
});
