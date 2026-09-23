import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import { base64UrlEncode } from "../src/base64url.js";
import { assembleJwt, createSigningInput, verifyJwt } from "../src/jwt.js";

describe("verifyJwt", () => {
  function signedToken(overrides: { header?: Record<string, unknown>; payload?: Record<string, unknown> } = {}) {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    const { signingInput, headerB64, payloadB64 } = createSigningInput({
      header: { alg: "EdDSA", ...overrides.header },
      payload: { sub: "user", ...overrides.payload },
    });
    const token = assembleJwt(headerB64, payloadB64, ed25519.sign(signingInput, privateKey));
    return { token, publicKey };
  }

  it("accepts a well-formed, correctly signed token", () => {
    const { token, publicKey } = signedToken();
    const { header, payload } = verifyJwt(token, publicKey);
    expect(header.alg).toBe("EdDSA");
    expect(payload.sub).toBe("user");
  });

  it("rejects a token that is not 3 dot-separated parts", () => {
    const { publicKey } = signedToken();
    expect(() => verifyJwt("only.two", publicKey)).toThrowError(/expected 3 parts/);
    expect(() => verifyJwt("a.b.c.d", publicKey)).toThrowError(/expected 3 parts/);
  });

  it("rejects a header or payload segment that decodes to non-object JSON", () => {
    const { publicKey } = signedToken();
    const arraySegment = base64UrlEncode(JSON.stringify([1, 2]));
    const primitiveSegment = base64UrlEncode(JSON.stringify("hi"));
    expect(() => verifyJwt(`${arraySegment}.${primitiveSegment}.sig`, publicKey)).toThrowError(
      /segment is not a JSON object/
    );
  });

  it("rejects an unsupported alg", () => {
    const { token, publicKey } = signedToken({ header: { alg: "HS256" } });
    expect(() => verifyJwt(token, publicKey)).toThrowError(/Unsupported alg: HS256/);
  });

  it("rejects a token with an invalid signature", () => {
    const { token, publicKey } = signedToken();
    const [headerB64, payloadB64] = token.split(".");
    const tampered = `${headerB64}.${payloadB64}.${base64UrlEncode(new Uint8Array(64))}`;
    expect(() => verifyJwt(tampered, publicKey)).toThrowError(/Invalid Ed25519 signature/);
  });

  it("rejects a token signed by a different key", () => {
    const { token } = signedToken();
    const otherPublicKey = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
    expect(() => verifyJwt(token, otherPublicKey)).toThrowError(/Invalid Ed25519 signature/);
  });
});
