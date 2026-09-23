import crypto from "node:crypto";
import { ed25519, ristretto255 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import { aeadDecrypt, aeadEncrypt, deriveAeadNonce } from "../src/aead.js";
import { base64UrlEncode } from "../src/base64url.js";
import { utf8 } from "../src/bytes.js";
import { calculateJwkThumbprint, createDPoPProof, DPoPExpectation, DPoPKeyPair, exportDPoPJwk, generateDPoPKeyPair, verifyDPoPProof } from "../src/dpop.js";
import { aggregateSignatureShares, computeBindingFactor, computeChallenge, computeGroupCommitment, computeSignatureShare, FrostCommitment, generateNonces, publicKeyOf, verifySignature } from "../src/frost.js";
import { assembleJwt, createSigningInput, deterministicJsonStringify, Jwt } from "../src/jwt.js";
import { invert, L, mod, randomScalar } from "../src/scalar.js";
import { combineShares, lagrangeCoefficient, Share, splitSecret } from "../src/shamir.js";
import { blind, deriveServerKey, evaluate, finalize, hashToGroup, unblind } from "../src/toprf.js";

describe("shamir secret sharing", () => {
  it("splits and combines back to the original secret at the threshold", () => {
    const secret = randomScalar();
    const shares = splitSecret(secret, 2, 3);
    expect(shares).toHaveLength(3);
    expect(shares.map((s) => s.id)).toEqual([1, 2, 3]);

    expect(combineShares([shares[0], shares[1]])).toBe(secret);
    expect(combineShares([shares[1], shares[2]])).toBe(secret);
    expect(combineShares([shares[0], shares[2]])).toBe(secret);
    expect(combineShares(shares)).toBe(secret);
  });

  it("a single share below the threshold does not recover the secret", () => {
    const secret = randomScalar();
    const [share] = splitSecret(secret, 2, 3);
    // Interpolating one point yields that point's own value.
    expect(combineShares([share])).toBe(share.value);
    expect(combineShares([share])).not.toBe(secret);
  });

  it("threshold equal to total requires every share", () => {
    const secret = randomScalar();
    const shares = splitSecret(secret, 3, 3);
    expect(combineShares(shares)).toBe(secret);
    expect(combineShares([shares[0], shares[1]])).not.toBe(secret);
  });

  it("rejects an invalid threshold", () => {
    expect(() => splitSecret(1n, 0, 3)).toThrowError(/Invalid threshold/);
    expect(() => splitSecret(1n, 4, 3)).toThrowError(/Invalid threshold/);
  });

  it("lagrangeCoefficient(0) reproduces the secret from raw shares by hand", () => {
    const secret = randomScalar();
    const shares = splitSecret(secret, 2, 3);
    const ids = [1, 2];
    const used = shares.filter((s) => ids.includes(s.id));
    const bySum = used.reduce((acc, s) => mod(acc + lagrangeCoefficient(ids, s.id) * s.value), 0n);
    expect(bySum).toBe(secret);
  });

  it("deals fresh random coefficients each time", () => {
    const secret = randomScalar();
    const a = splitSecret(secret, 2, 3);
    const b = splitSecret(secret, 2, 3);
    expect(a.map((s) => s.value)).not.toEqual(b.map((s) => s.value));
  });

  it("combineShares rejects an empty list and duplicate ids", () => {
    expect(() => combineShares([])).toThrowError(/At least one share/);
    const dup: Share[] = [{ id: 1, value: 1n }, { id: 1, value: 2n }];
    expect(() => combineShares(dup)).toThrowError(/Duplicate participant IDs/);
  });
});

describe("scalar arithmetic", () => {
  it("mod always returns a representative in [0, L)", () => {
    expect(mod(-1n)).toBe(L - 1n);
    expect(mod(L)).toBe(0n);
    expect(mod(0n)).toBe(0n);
  });

  it("randomScalar produces distinct values in range", () => {
    const a = randomScalar();
    const b = randomScalar();
    expect(a).not.toBe(b);
    expect(a >= 0n && a < L).toBe(true);
  });

  it("invert is the multiplicative inverse mod L, and rejects zero", () => {
    const a = 12345n;
    expect(mod(a * invert(a))).toBe(1n);
    expect(() => invert(0n)).toThrowError(/Zero has no modular inverse/);
    expect(() => invert(L)).toThrowError(/Zero has no modular inverse/);
  });
});

describe("FROST threshold signing", () => {
  interface Group {
    publicKey: Uint8Array;
    shares: Map<number, bigint>;
  }

  function dealGroupKey(threshold: number, total: number): Group {
    const secret = randomScalar();
    return { publicKey: publicKeyOf(secret), shares: new Map(splitSecret(secret, threshold, total).map((s) => [s.id, s.value])) };
  }

  /** Both rounds for every node in `nodeIds`, then aggregation. */
  function sign(group: Group, nodeIds: number[], msg: Uint8Array): Uint8Array {
    const signers = nodeIds.map((id) => ({ id, ...generateNonces() }));
    const commitments: FrostCommitment[] = signers.map((s) => ({ nodeId: s.id, ...s.commitment }));
    const shares = signers.map((s) => computeSignatureShare(s.id, s.nonces, group.shares.get(s.id)!, msg, commitments, group.publicKey, nodeIds));
    return aggregateSignatureShares(computeGroupCommitment(msg, commitments), shares);
  }

  it("produces a signature that verifies as a plain Ed25519 signature under the group key", () => {
    const group = dealGroupKey(2, 3);
    const msg = utf8("hello frost");
    const signature = sign(group, [1, 2, 3], msg);
    expect(verifySignature(signature, msg, group.publicKey)).toBe(true);
    expect(signature).toHaveLength(64);
  });

  it.each([{ quorum: [1, 2] }, { quorum: [2, 3] }, { quorum: [1, 3] }])("verifies with the 2-of-3 quorum $quorum", ({ quorum }) => {
    const group = dealGroupKey(2, 3);
    const msg = utf8("quorum message");
    expect(verifySignature(sign(group, quorum, msg), msg, group.publicKey)).toBe(true);
  });

  it("fails to verify with a wrong message, wrong key, or too few signers", () => {
    const group = dealGroupKey(3, 3);
    const msg = utf8("integrity");
    const signature = sign(group, [1, 2, 3], msg);
    expect(verifySignature(signature, utf8("tampered"), group.publicKey)).toBe(false);
    expect(verifySignature(signature, msg, publicKeyOf(randomScalar()))).toBe(false);
    expect(verifySignature(sign(group, [1, 2], msg), msg, group.publicKey)).toBe(false);
  });

  it("binding factors differ per signer and per message", () => {
    const commitments: FrostCommitment[] = [1, 2].map((id) => ({ nodeId: id, ...generateNonces().commitment }));
    const msgA = utf8("a");
    const msgB = utf8("b");
    expect(computeBindingFactor(1, msgA, commitments)).not.toBe(computeBindingFactor(2, msgA, commitments));
    expect(computeBindingFactor(1, msgA, commitments)).not.toBe(computeBindingFactor(1, msgB, commitments));
  });

  it("the group commitment does not depend on the order commitments are listed in", () => {
    const commitments: FrostCommitment[] = [1, 2, 3].map((id) => ({ nodeId: id, ...generateNonces().commitment }));
    const msg = utf8("order independence");
    expect(computeGroupCommitment(msg, commitments)).toEqual(computeGroupCommitment(msg, [...commitments].reverse()));
  });

  it("computeChallenge is deterministic in its three inputs", () => {
    const R = generateNonces().commitment.D;
    const Y = publicKeyOf(randomScalar());
    const msg = utf8("challenge");
    expect(computeChallenge(R, Y, msg)).toBe(computeChallenge(R, Y, msg));
    expect(computeChallenge(R, Y, msg)).not.toBe(computeChallenge(R, Y, utf8("other")));
  });

  it("verifySignature returns false rather than throwing on garbage input", () => {
    expect(verifySignature(new Uint8Array(3), utf8("m"), publicKeyOf(1n))).toBe(false);
  });
});

describe("TOPRF (PASTA)", () => {
  /** The client's run against the nodes in `ids`: blind, evaluate at each, unblind, finalize. */
  function toprf(key: Share[], password: string, ids: number[]): Uint8Array {
    const { blinding, blinded } = blind(password);
    const partials = ids.map((id) => ({ id, point: evaluate(key.find((s) => s.id === id)!, blinded) }));
    return finalize(password, unblind(blinding, partials));
  }

  it("any quorum yields the same h for the same password", () => {
    const key = splitSecret(randomScalar(), 2, 3);
    const password = "correct horse battery staple";
    const h = toprf(key, password, [1, 2]);
    expect(h).toHaveLength(32);
    expect(toprf(key, password, [2, 3])).toEqual(h);
    expect(toprf(key, password, [1, 2, 3])).toEqual(h);
  });

  it("a single share below the threshold yields a different, wrong h", () => {
    const key = splitSecret(randomScalar(), 2, 3);
    expect(toprf(key, "pw", [1])).not.toEqual(toprf(key, "pw", [1, 2]));
  });

  it("a different password yields a different h", () => {
    const key = splitSecret(randomScalar(), 2, 3);
    expect(toprf(key, "password-a", [1, 2])).toEqual(toprf(key, "password-a", [1, 2]));
    expect(toprf(key, "password-a", [1, 2])).not.toEqual(toprf(key, "password-b", [1, 2]));
  });

  it("deriveServerKey differs per node id, deterministically", () => {
    const h = new Uint8Array(32).fill(7);
    const h1 = deriveServerKey(h, 1);
    expect(h1).toHaveLength(32);
    expect(deriveServerKey(h, 1)).toEqual(h1);
    expect(deriveServerKey(h, 2)).not.toEqual(h1);
  });

  it("hashToGroup is deterministic and lands on the curve", () => {
    const p1 = hashToGroup("same");
    const p2 = hashToGroup("same");
    expect(p1.toRawBytes()).toEqual(p2.toRawBytes());
    expect(() => ristretto255.Point.fromBytes(p1.toRawBytes())).not.toThrow();
  });

  it("unblind rejects an empty partial list", () => {
    expect(() => unblind({ r: 1n }, [])).toThrowError(/At least one partial evaluation/);
  });
});

describe("AEAD (ChaCha20-Poly1305)", () => {
  it("round-trips plaintext under the right key, nonce and AAD", () => {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const aad = utf8("signing-input");
    const plaintext = utf8(JSON.stringify({ z_i: "12345" }));

    const ct = aeadEncrypt(key, nonce, plaintext, aad);
    expect(aeadDecrypt(key, nonce, ct, aad)).toEqual(plaintext);
  });

  it("fails to decrypt with the wrong key, nonce, ciphertext or AAD", () => {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const aad = utf8("aad");
    const ct = aeadEncrypt(key, nonce, utf8("secret"), aad);

    expect(() => aeadDecrypt(crypto.randomBytes(32), nonce, ct, aad)).toThrow();
    expect(() => aeadDecrypt(key, crypto.randomBytes(12), ct, aad)).toThrow();
    expect(() => aeadDecrypt(key, nonce, ct, utf8("different aad"))).toThrow();
    const flipped = new Uint8Array(ct);
    flipped[0] ^= 0xff;
    expect(() => aeadDecrypt(key, nonce, flipped, aad)).toThrow();
  });

  it("deriveAeadNonce is deterministic per (sessionNonce, id) and differs across ids", () => {
    const sessionNonce = crypto.randomBytes(16);
    const n1 = deriveAeadNonce(sessionNonce, 1);
    expect(n1).toHaveLength(12);
    expect(deriveAeadNonce(sessionNonce, 1)).toEqual(n1);
    expect(deriveAeadNonce(sessionNonce, 2)).not.toEqual(n1);
  });
});

describe("deterministicJsonStringify", () => {
  it("sorts object keys at every level", () => {
    expect(deterministicJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(deterministicJsonStringify({ z: { y: 1, x: 2 }, a: 1 })).toBe('{"a":1,"z":{"x":2,"y":1}}');
  });

  it("drops members whose value is undefined, but keeps null", () => {
    expect(deterministicJsonStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(deterministicJsonStringify({ a: null, b: 1 })).toBe('{"a":null,"b":1}');
  });

  it("preserves array order and recurses into array elements", () => {
    expect(deterministicJsonStringify([{ b: 1, a: 2 }, 3, "x"])).toBe('[{"a":2,"b":1},3,"x"]');
  });

  it("is stable across re-orderings of the same object", () => {
    const one = deterministicJsonStringify({ iat: 1, exp: 2, sub: "s", iss: "i" });
    const two = deterministicJsonStringify({ iss: "i", sub: "s", exp: 2, iat: 1 });
    expect(one).toBe(two);
  });
});

describe("DPoP", () => {
  const htu = "http://localhost:3000/token";
  const now = 1_700_000_000;

  function expecting(keyPair: DPoPKeyPair): DPoPExpectation {
    return { htm: "POST", htu, jkt: calculateJwkThumbprint(exportDPoPJwk(keyPair.publicKey)), now, maxAgeSeconds: 60 };
  }

  /** A proof with any header and payload, for what createDPoPProof refuses to produce. */
  function signedProof(keyPair: DPoPKeyPair, jwt: Jwt): string {
    const { signingInput, headerB64, payloadB64 } = createSigningInput(jwt);
    return assembleJwt(headerB64, payloadB64, ed25519.sign(signingInput, keyPair.privateKey));
  }

  it("creates a proof that verifies against the expected method, URL and thumbprint", () => {
    const keyPair = generateDPoPKeyPair();
    const token = createDPoPProof(keyPair, "post", htu, now);
    const { jti } = verifyDPoPProof(token, expecting(keyPair));
    expect(jti.length).toBeGreaterThan(0);
  });

  it("calculateJwkThumbprint is deterministic and RFC 7638 canonical", () => {
    const jwk = exportDPoPJwk(generateDPoPKeyPair().publicKey);
    expect(calculateJwkThumbprint(jwk)).toBe(calculateJwkThumbprint(jwk));
    expect(calculateJwkThumbprint(jwk)).toBe(calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }));
  });

  it("rejects a proof for the wrong method", () => {
    const keyPair = generateDPoPKeyPair();
    const token = createDPoPProof(keyPair, "GET", htu, now);
    expect(() => verifyDPoPProof(token, expecting(keyPair))).toThrowError(/htm mismatch/);
  });

  it("rejects a proof for the wrong URL", () => {
    const keyPair = generateDPoPKeyPair();
    const token = createDPoPProof(keyPair, "POST", "http://evil.test/token", now);
    expect(() => verifyDPoPProof(token, expecting(keyPair))).toThrowError(/htu mismatch/);
  });

  it("rejects a proof signed by a key whose thumbprint does not match", () => {
    const token = createDPoPProof(generateDPoPKeyPair(), "POST", htu, now);
    expect(() => verifyDPoPProof(token, expecting(generateDPoPKeyPair()))).toThrowError(/thumbprint mismatch/);
  });

  it("rejects a stale iat, outside maxAgeSeconds in either direction", () => {
    const keyPair = generateDPoPKeyPair();
    const stale = createDPoPProof(keyPair, "POST", htu, now - 61);
    const future = createDPoPProof(keyPair, "POST", htu, now + 61);
    expect(() => verifyDPoPProof(stale, expecting(keyPair))).toThrowError(/timestamp expired or out of allowed window/);
    expect(() => verifyDPoPProof(future, expecting(keyPair))).toThrowError(/timestamp expired or out of allowed window/);
  });

  it("rejects a malformed or non-OKP/Ed25519 jwk in the header", () => {
    const expectation = { htm: "POST", htu, jkt: "x", now, maxAgeSeconds: 60 };
    expect(() => verifyDPoPProof("not-a-jwt", expectation)).toThrowError(/Invalid DPoP proof JWT format/);

    const rsaHeader = base64UrlEncode(JSON.stringify({ jwk: { kty: "RSA" } }));
    expect(() => verifyDPoPProof(`${rsaHeader}.e30.sig`, expectation)).toThrowError(/Invalid or missing OKP\/Ed25519 jwk/);

    const shortKeyHeader = base64UrlEncode(JSON.stringify({ jwk: { kty: "OKP", crv: "Ed25519", x: base64UrlEncode(Uint8Array.of(1, 2, 3)) } }));
    expect(() => verifyDPoPProof(`${shortKeyHeader}.e30.sig`, expectation)).toThrowError(/Invalid public key length/);
  });

  it("rejects the wrong typ", () => {
    const keyPair = generateDPoPKeyPair();
    const token = signedProof(keyPair, {
      header: { typ: "JWT", alg: "EdDSA", jwk: exportDPoPJwk(keyPair.publicKey) },
      payload: { jti: "x", htm: "POST", htu, iat: now },
    });
    expect(() => verifyDPoPProof(token, expecting(keyPair))).toThrowError(/Invalid typ/);
  });

  it("rejects a well-formed, well-signed proof with no jti", () => {
    const keyPair = generateDPoPKeyPair();
    const token = signedProof(keyPair, {
      header: { typ: "dpop+jwt", alg: "EdDSA", jwk: exportDPoPJwk(keyPair.publicKey) },
      payload: { htm: "POST", htu, iat: now },
    });
    expect(() => verifyDPoPProof(token, expecting(keyPair))).toThrowError(/DPoP proof has no jti/);
  });
});
