import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { z } from "zod";
import { aeadEncrypt, deriveAeadNonce } from "../src/aead.js";
import { base64UrlDecode, base64UrlEncode } from "../src/base64url.js";
import { utf8 } from "../src/bytes.js";
import { calculateJwkThumbprint, exportDPoPJwk } from "../src/dpop.js";
import {
  FrostCommitment,
  aggregateSignatureShares,
  computeBindingFactor,
  computeChallenge,
  computeGroupCommitment,
  computeSignatureShare,
  publicKeyOf,
  verifySignature,
} from "../src/frost.js";
import { bigIntToHex, bytesToHex, hexToBigInt } from "../src/hex.js";
import { Jwt, assembleJwt, createSigningInput, deterministicJsonStringify } from "../src/jwt.js";
import * as api from "../src/node-api.js";
import { mod, scalarFromBytesLE } from "../src/scalar.js";
import { combineShares, lagrangeCoefficient } from "../src/shamir.js";
import { accessTokenJwt, assertionJwt, refreshTokenJwt } from "../src/tokens.js";
import { deriveServerKey, evaluate, finalize, hashToGroup, unblind } from "../src/toprf.js";

/**
 * What `../protocol` holds, computed from this package: the JSON Schema of every node API
 * body and test vectors from fixed inputs. `tests/protocol.test.ts` compares the result
 * with the committed files; `generate-protocol.ts` writes them.
 *
 * Bytes are base64url and scalars 64 hex digits, as on the wire.
 */

/** Relative path inside `protocol/` -> JSON content. */
export type ProtocolFiles = Record<string, unknown>;

export function generateProtocolFiles(): ProtocolFiles {
  return { ...generateSchemas(), ...generateVectors() };
}

// ---- JSON Schema ----------------------------------------------------------------

const bodies = {
  "health.response": api.healthResponse,
  "commit.request": api.commitRequest,
  "commit.response": api.commitResponse,
  "sign-on.request": api.signOnRequest,
  "sign-on.response": api.signOnResponse,
  "sign.request": api.signRequest,
  "sign.response": api.signResponse,
};

export function generateSchemas(): ProtocolFiles {
  return Object.fromEntries(
    Object.entries(bodies).map(([name, schema]) => [`schema/node-api/${name}.json`, z.toJSONSchema(schema, { io: "input" })])
  );
}

// ---- Vectors --------------------------------------------------------------------

export function generateVectors(): ProtocolFiles {
  const tokens = tokenVectors();
  const frost = frostVectors(tokens.assertion.signingInput);
  const toprf = toprfVectors();
  const node1Key = toprf.serverKeys.find((k) => k.id === 1)!;
  const node1Signer = frost.signers.find((s) => s.nodeId === 1)!;
  const aead = aeadVectors(tokens.assertion.signingInput, base64UrlDecode(node1Key.h_i), hexToBigInt(node1Signer.z_i));
  return {
    "vectors/base64url.json": base64UrlVectors(),
    "vectors/scalar-hex.json": scalarHexVectors(),
    "vectors/deterministic-json.json": deterministicJsonVectors(),
    "vectors/tokens.json": tokens,
    "vectors/shamir.json": shamirVectors(),
    "vectors/frost.json": frost,
    "vectors/toprf.json": toprf,
    "vectors/aead.json": aead,
    "vectors/dpop.json": dpopVectors(),
  };
}

/** A fixed scalar named by a label, so the inputs are reproducible and readable in the generator. */
function fixedScalar(label: string): bigint {
  return scalarFromBytesLE(sha512(utf8(label)));
}

function fixedBytes(label: string, length: number): Uint8Array {
  return sha512(utf8(label)).slice(0, length);
}

/** The RFC 4648 §10 inputs, plus bytes that exercise `-`, `_` and leading zeros. */
function base64UrlVectors() {
  const inputs = [...["", "f", "fo", "foo", "foob", "fooba", "foobar"].map(utf8), Uint8Array.of(0xff, 0xfb, 0xfe), Uint8Array.of(0x00, 0x00)];
  return {
    valid: inputs.map((bytes) => ({ hex: bytesToHex(bytes), base64url: base64UrlEncode(bytes) })),
    invalid: ["Zm9v=", "Zm9+", "Zm8/", "Zg=", "Z", "Zm9vY", "Zm 9v"],
  };
}

function scalarHexVectors() {
  const values = [0n, 1n, 255n, 0x1234abcdn, ed25519.CURVE.n - 1n];
  return {
    valid: values.map((value) => ({ hex: bigIntToHex(value), decimal: value.toString() })),
    invalid: ["", "0x01", "01", "0".repeat(63), "0".repeat(65), "G".repeat(64), "A".repeat(64)],
  };
}

function deterministicJsonVectors() {
  const inputs: unknown[] = [
    { b: 1, a: 2 },
    { z: { y: [3, { k: "v", a: null }], x: true }, a: "text" },
    [{ b: 1, a: 2 }, [2, 1], "s", 0, false, null],
    { "": 0, " ": 1, A: 2, a: 3, "0": 4 },
    { text: 'quote " backslash \\ newline \n tab \t 日本語' },
    { n: -1, zero: 0, big: 1700000000 },
    {},
    [],
  ];
  return { cases: inputs.map((input) => ({ input, output: deterministicJsonStringify(input) })) };
}

function jwtVector(jwt: Jwt) {
  const { headerB64, payloadB64, signingInput } = createSigningInput(jwt);
  return {
    header: jwt.header,
    payload: jwt.payload,
    headerJson: deterministicJsonStringify(jwt.header),
    payloadJson: deterministicJsonStringify(jwt.payload),
    headerB64,
    payloadB64,
    signingInput: new TextDecoder().decode(signingInput),
  };
}

function tokenVectors() {
  const issuer = { issuer: "https://idp.example", keyId: "pasta-group-key-1" };
  const sub = "usr_alice_12345";
  const request = { clientId: "demo_client", scope: "openid profile", cnfJkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I", iat: 1700000000, exp: 1700000030 };
  const credential = { sub, client_id: request.clientId, scope: request.scope, cnf: { jkt: request.cnfJkt } };
  const claims = { iat: 1700000010, exp: 1700003610, jti: "3f2b7c1e-9d4a-4e0b-8c6f-1a2b3c4d5e6f" };
  const assertionRequest = { ...request, nonce: "c-8f3a2b1c" };
  const refreshTokenExp = claims.iat + 86400 * 30;
  return {
    issuer,
    sub,
    assertionRequest,
    credential,
    accessTokenClaims: claims,
    refreshTokenExp,
    assertion: jwtVector(assertionJwt(issuer, sub, assertionRequest)),
    assertionWithoutNonce: jwtVector(assertionJwt(issuer, sub, request)),
    accessToken: jwtVector(accessTokenJwt(issuer, credential, claims)),
    refreshToken: jwtVector(refreshTokenJwt(issuer, credential, claims.iat, refreshTokenExp)),
  };
}

/** Shares of a fixed degree-1 polynomial f(x) = secret + a·x: threshold 2. */
function fixedShares(secret: bigint, a: bigint, total: number) {
  return Array.from({ length: total }, (_, i) => ({ id: i + 1, value: mod(secret + a * BigInt(i + 1)) }));
}

function shamirVectors() {
  const idSets = [[1, 2], [1, 3], [1, 2, 3], [2, 3, 5]];
  const secret = fixedScalar("shamir secret");
  const shares = fixedShares(secret, fixedScalar("shamir coefficient a1"), 3);
  return {
    lagrange: idSets.map((ids) => ({ ids, lambda: Object.fromEntries(ids.map((id) => [id, bigIntToHex(lagrangeCoefficient(ids, id))])) })),
    combine: {
      threshold: 2,
      shares: shares.map((s) => ({ id: s.id, value: bigIntToHex(s.value) })),
      secret: bigIntToHex(secret),
      recovered: bigIntToHex(combineShares([shares[0], shares[2]])),
    },
  };
}

/** A 2-of-3 group where nodes 1 and 3 sign `msg`, the assertion's signing input. */
function frostVectors(signingInput: string) {
  const msg = utf8(signingInput);
  const secret = fixedScalar("frost group secret");
  const shares = fixedShares(secret, fixedScalar("frost coefficient a1"), 3);
  const groupPublicKey = publicKeyOf(secret);
  const participants = [1, 3];
  const signers = participants.map((nodeId) => {
    const d = fixedScalar(`frost d_${nodeId}`);
    const e = fixedScalar(`frost e_${nodeId}`);
    return { nodeId, d, e, D: publicKeyOf(d), E: publicKeyOf(e) };
  });
  const commitments: FrostCommitment[] = signers.map(({ nodeId, D, E }) => ({ nodeId, D, E }));
  const shareOf = (nodeId: number) => shares[nodeId - 1].value;
  const signatureShare = (s: (typeof signers)[number]) => computeSignatureShare(s.nodeId, s, shareOf(s.nodeId), msg, commitments, groupPublicKey, participants);
  const R = computeGroupCommitment(msg, commitments);
  const c = computeChallenge(R, groupPublicKey, msg);
  const signature = aggregateSignatureShares(R, signers.map(signatureShare));
  if (!verifySignature(signature, msg, groupPublicKey)) {
    throw new Error("FROST vector does not verify");
  }
  return {
    threshold: 2,
    total: 3,
    groupSecret: bigIntToHex(secret),
    groupPublicKey: base64UrlEncode(groupPublicKey),
    shares: shares.map((s) => ({ id: s.id, s_i: bigIntToHex(s.value) })),
    msg: base64UrlEncode(msg),
    participants,
    signers: signers.map((s) => ({
      nodeId: s.nodeId,
      s_i: bigIntToHex(shareOf(s.nodeId)),
      lambda_i: bigIntToHex(lagrangeCoefficient(participants, s.nodeId)),
      d: bigIntToHex(s.d),
      e: bigIntToHex(s.e),
      D: base64UrlEncode(s.D),
      E: base64UrlEncode(s.E),
      rho_i: bigIntToHex(computeBindingFactor(s.nodeId, msg, commitments)),
      z_i: bigIntToHex(signatureShare(s)),
    })),
    R: base64UrlEncode(R),
    c: bigIntToHex(c),
    signature: base64UrlEncode(signature),
  };
}

function toprfVectors() {
  const password = "correct horse battery staple";
  const k = fixedScalar("toprf key k");
  const shares = fixedShares(k, fixedScalar("toprf coefficient a1"), 3);
  const r = fixedScalar("toprf blinding r");
  const participants = [1, 2];
  const H1 = hashToGroup(password);
  const A = H1.multiply(r);
  const partials = participants.map((id) => ({ id, point: evaluate(shares[id - 1], A) }));
  const v = unblind({ r }, partials);
  if (!v.equals(H1.multiply(k))) {
    throw new Error("TOPRF vector does not unblind to k·H1(pw)");
  }
  const h = finalize(password, v);
  return {
    threshold: 2,
    total: 3,
    password,
    k: bigIntToHex(k),
    shares: shares.map((s) => ({ id: s.id, k_i: bigIntToHex(s.value) })),
    r: bigIntToHex(r),
    H1: base64UrlEncode(H1.toRawBytes()),
    A: base64UrlEncode(A.toRawBytes()),
    participants,
    partials: partials.map((p) => ({ id: p.id, B_i: base64UrlEncode(p.point.toRawBytes()) })),
    v: base64UrlEncode(v.toRawBytes()),
    h: base64UrlEncode(h),
    serverKeys: [1, 2, 3].map((id) => ({ id, h_i: base64UrlEncode(deriveServerKey(h, id)) })),
  };
}

/** What a node returns at `/sign-on`: z_1 under h_1, bound to the assertion's signing input. */
function aeadVectors(signingInput: string, h_1: Uint8Array, z_1: bigint) {
  const sessionNonce = fixedBytes("aead session nonce", 16);
  const nodeId = 1;
  const nonce = deriveAeadNonce(sessionNonce, nodeId);
  const plaintext = utf8(JSON.stringify({ z_i: z_1.toString() }));
  const aad = utf8(signingInput);
  return {
    key: base64UrlEncode(h_1),
    sessionNonce: base64UrlEncode(sessionNonce),
    nodeId,
    nonce: base64UrlEncode(nonce),
    aad: base64UrlEncode(aad),
    plaintextUtf8: new TextDecoder().decode(plaintext),
    plaintext: base64UrlEncode(plaintext),
    ciphertext: base64UrlEncode(aeadEncrypt(h_1, nonce, plaintext, aad)),
  };
}

function dpopVectors() {
  const privateKey = fixedBytes("dpop private key", 32);
  const publicKey = ed25519.getPublicKey(privateKey);
  const jwk = exportDPoPJwk(publicKey);
  const expected = { htm: "POST", htu: "https://idp.example/token", iat: 1700000010 };
  const jwt: Jwt = {
    header: { typ: "dpop+jwt", alg: "EdDSA", jwk },
    payload: { jti: "7d5e4f3a-2b1c-4d0e-9f8a-6b5c4d3e2f1a", ...expected },
  };
  const { signingInput, headerB64, payloadB64 } = createSigningInput(jwt);
  const signature = ed25519.sign(signingInput, privateKey);
  return {
    privateKey: base64UrlEncode(privateKey),
    publicKey: base64UrlEncode(publicKey),
    jwk,
    thumbprintJson: deterministicJsonStringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }),
    jkt: calculateJwkThumbprint(jwk),
    proof: {
      ...jwtVector(jwt),
      signature: base64UrlEncode(signature),
      jwt: assembleJwt(headerB64, payloadB64, signature),
      expected: { ...expected, jkt: calculateJwkThumbprint(jwk), now: expected.iat + 5, maxAgeSeconds: 60 },
    },
  };
}
