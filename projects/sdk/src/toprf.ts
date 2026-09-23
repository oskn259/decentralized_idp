import { ristretto255 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes, u16ToBytesLE, u64ToBytesLE, utf8 } from "./bytes.js";
import { invert, randomScalar } from "./scalar.js";
import { Share, lagrangeCoefficient } from "./shamir.js";

/**
 * Threshold oblivious PRF over Ristretto255 (PASTA). The client blinds the password,
 * each node applies its key share to the blinded point, and only the client can unblind
 * and finalize to h. The domain-separation strings and length prefixes are the protocol.
 */

export type RistrettoPoint = typeof ristretto255.Point.BASE;

export interface Blinding {
  r: bigint;
}

export interface PartialEvaluation {
  id: number;
  point: RistrettoPoint;
}

/** H1: password -> group element, via SHA-512 to 64 uniform bytes then hash-to-curve. */
export function hashToGroup(password: string): RistrettoPoint {
  const pw = utf8(password);
  const digest = sha512(concatBytes(utf8("PASTA-TOPRF-H1"), u64ToBytesLE(pw.length), pw));
  return ristretto255.Point.hashToCurve(digest);
}

/** Client: A = r·H1(pw) with a fresh secret r. */
export function blind(password: string): { blinding: Blinding; blinded: RistrettoPoint } {
  const r = randomScalar();
  return { blinding: { r }, blinded: hashToGroup(password).multiply(r) };
}

/** Node i: B_i = k_i·A. Learns nothing about pw, because of r. */
export function evaluate(keyShare: Share, blinded: RistrettoPoint): RistrettoPoint {
  return blinded.multiply(keyShare.value);
}

/** Client: v = r⁻¹·Σ λ_i·B_i = k·H1(pw). */
export function unblind(blinding: Blinding, partials: PartialEvaluation[]): RistrettoPoint {
  if (partials.length === 0) {
    throw new Error("At least one partial evaluation is required");
  }
  const ids = partials.map((p) => p.id);
  const combined = partials
    .map((p) => p.point.multiply(lagrangeCoefficient(ids, p.id)))
    .reduce((sum, point) => sum.add(point), ristretto255.Point.ZERO);
  return combined.multiply(invert(blinding.r));
}

/** H2: h = H(pw, v), 32 bytes. The master key only the password holder can compute. */
export function finalize(password: string, v: RistrettoPoint): Uint8Array {
  const pw = utf8(password);
  const digest = sha512(concatBytes(utf8("PASTA-TOPRF-H2"), u64ToBytesLE(pw.length), pw, v.toRawBytes()));
  return digest.slice(0, 32);
}

/** H-PRIME: h_i = H(h, i), the per-node key under which node i encrypts its signature share. */
export function deriveServerKey(h: Uint8Array, id: number): Uint8Array {
  const digest = sha512(concatBytes(utf8("PASTA-TOPRF-H-PRIME"), h, u16ToBytesLE(id)));
  return digest.slice(0, 32);
}
