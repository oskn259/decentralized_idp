import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ristretto255 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import { generateProtocolFiles } from "../scripts/protocol.js";
import { aeadDecrypt, deriveAeadNonce } from "../src/aead.js";
import { base64UrlDecode, base64UrlEncode } from "../src/base64url.js";
import { utf8 } from "../src/bytes.js";
import { calculateJwkThumbprint, verifyDPoPProof } from "../src/dpop.js";
import { aggregateSignatureShares, computeGroupCommitment, verifySignature } from "../src/frost.js";
import { bigIntToHex, hexToBigInt, hexToBytes } from "../src/hex.js";
import { deterministicJsonStringify } from "../src/jwt.js";
import { scalar } from "../src/node-api.js";
import { openUserShare } from "../src/register.js";
import { combineShares, lagrangeCoefficient } from "../src/shamir.js";
import { deriveServerKey, finalize, unblind } from "../src/toprf.js";

/**
 * `../protocol` is the spec: this package reproduces it exactly and accepts what it says.
 * After an intended change, `npm run protocol:generate` rewrites it; review the diff.
 */

const protocolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../protocol");

function readJson(relative: string): any {
  return JSON.parse(fs.readFileSync(path.join(protocolDir, relative), "utf8"));
}

function listJson(dir: string): string[] {
  return fs
    .readdirSync(path.join(protocolDir, dir), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort();
}

describe("committed protocol files", () => {
  const generated = generateProtocolFiles();
  const committed = [...listJson("schema"), ...listJson("vectors")];

  it("are exactly the generated set", () => {
    expect(committed, "run `npm run protocol:generate` and review ../protocol").toEqual(Object.keys(generated).sort());
  });

  it.each(committed)("%s matches what the sdk generates", (relative) => {
    expect(readJson(relative), `${relative} is stale: run \`npm run protocol:generate\` and review the diff`).toEqual(generated[relative]);
  });
});

describe("the sdk accepts the committed vectors", () => {
  it("base64url", () => {
    const v = readJson("vectors/base64url.json");
    for (const c of v.valid) {
      const bytes = hexToBytes(c.hex);
      expect(base64UrlEncode(bytes)).toBe(c.base64url);
      expect(base64UrlDecode(c.base64url)).toEqual(bytes);
    }
    for (const text of v.invalid) {
      expect(() => base64UrlDecode(text), text).toThrow();
    }
  });

  it("scalar hex", () => {
    const v = readJson("vectors/scalar-hex.json");
    for (const c of v.valid) {
      expect(hexToBigInt(c.hex).toString()).toBe(c.decimal);
      expect(bigIntToHex(BigInt(c.decimal))).toBe(c.hex);
    }
    for (const text of v.invalid) {
      expect(scalar.safeParse(text).success, text).toBe(false);
    }
  });

  it("deterministic JSON", () => {
    for (const c of readJson("vectors/deterministic-json.json").cases) {
      expect(deterministicJsonStringify(c.input)).toBe(c.output);
    }
  });

  it("Shamir", () => {
    const v = readJson("vectors/shamir.json");
    for (const c of v.lagrange) {
      for (const id of c.ids) {
        expect(bigIntToHex(lagrangeCoefficient(c.ids, id))).toBe(c.lambda[id]);
      }
    }
    const shares = v.combine.shares.map((s: any) => ({ id: s.id, value: hexToBigInt(s.value) }));
    expect(bigIntToHex(combineShares(shares.slice(0, 2)))).toBe(v.combine.secret);
    expect(v.combine.recovered).toBe(v.combine.secret);
  });

  it("FROST: the shares add up to a signature that verifies under the group key", () => {
    const v = readJson("vectors/frost.json");
    const msg = base64UrlDecode(v.msg);
    const commitments = v.signers.map((s: any) => ({ nodeId: s.nodeId, D: base64UrlDecode(s.D), E: base64UrlDecode(s.E) }));
    const R = computeGroupCommitment(msg, commitments);
    expect(base64UrlEncode(R)).toBe(v.R);
    const signature = aggregateSignatureShares(R, v.signers.map((s: any) => hexToBigInt(s.z_i)));
    expect(base64UrlEncode(signature)).toBe(v.signature);
    expect(verifySignature(signature, msg, base64UrlDecode(v.groupPublicKey))).toBe(true);
  });

  it("TOPRF: the partials unblind and finalize to h, and h_i follows", () => {
    const v = readJson("vectors/toprf.json");
    const partials = v.partials.map((p: any) => ({ id: p.id, point: ristretto255.Point.fromBytes(base64UrlDecode(p.B_i)) }));
    const value = unblind({ r: hexToBigInt(v.r) }, partials);
    expect(base64UrlEncode(value.toRawBytes())).toBe(v.v);
    const h = finalize(v.password, value);
    expect(base64UrlEncode(h)).toBe(v.h);
    for (const k of v.serverKeys) {
      expect(base64UrlEncode(deriveServerKey(h, k.id))).toBe(k.h_i);
    }
  });

  it("AEAD: the ciphertext decrypts to the plaintext under the derived nonce", () => {
    const v = readJson("vectors/aead.json");
    const nonce = deriveAeadNonce(base64UrlDecode(v.sessionNonce), v.nodeId);
    expect(base64UrlEncode(nonce)).toBe(v.nonce);
    const plain = aeadDecrypt(base64UrlDecode(v.key), nonce, base64UrlDecode(v.ciphertext), base64UrlDecode(v.aad));
    expect(plain).toEqual(base64UrlDecode(v.plaintext));
    expect(plain).toEqual(utf8(v.plaintextUtf8));
  });

  it("seal: the node opens its share under the AAD of its id and the username", () => {
    const v = readJson("vectors/seal.json");
    const box = { ephemeralPublicKey: base64UrlDecode(v.ephemeralPublicKey), ciphertext: base64UrlDecode(v.ciphertext) };
    const share = openUserShare(base64UrlDecode(v.nodeSecretKey), box, v.nodeId, v.username);
    expect(bigIntToHex(share.toprfKeyShare.value)).toBe(readJson("vectors/toprf.json").shares[0].k_i);
    expect(base64UrlEncode(share.h_i)).toBe(readJson("vectors/toprf.json").serverKeys[0].h_i);
    expect(() => openUserShare(base64UrlDecode(v.nodeSecretKey), box, 2, v.username)).toThrow();
    expect(() => openUserShare(base64UrlDecode(v.nodeSecretKey), box, v.nodeId, "bob")).toThrow();
  });

  it("DPoP: the thumbprint and the proof are accepted", () => {
    const v = readJson("vectors/dpop.json");
    expect(calculateJwkThumbprint(v.jwk)).toBe(v.jkt);
    expect(verifyDPoPProof(v.proof.jwt, v.proof.expected)).toEqual({ jti: v.proof.payload.jti });
  });
});
