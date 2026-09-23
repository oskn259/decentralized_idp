import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes } from "./bytes.js";
import { mod, randomScalar, scalarFromBytesLE, scalarToBytesLE } from "./scalar.js";
import { lagrangeCoefficient } from "./shamir.js";

/**
 * FROST threshold signing that aggregates into a plain Ed25519 signature (R ‖ z).
 *
 * Signers run rounds 1 and 2; the aggregator (browser or gateway) computes R and sums the
 * shares. The byte layouts hashed here are the protocol: every party must hash the same.
 */

/** Round-1 commitment of one signer: D = d·B, E = e·B, 32 bytes each. */
export interface Commitment {
  D: Uint8Array;
  E: Uint8Array;
}

/** A commitment as it travels between parties: tagged with its signer. */
export interface FrostCommitment extends Commitment {
  nodeId: number;
}

/** The secret half of a commitment. Spent by exactly one signature share. */
export interface FrostNonces {
  d: bigint;
  e: bigint;
}

const BASE = ed25519.ExtendedPoint.BASE;

export function publicKeyOf(secret: bigint): Uint8Array {
  return BASE.multiply(mod(secret)).toRawBytes();
}

/** Signer, round 1: fresh (d, e) and the commitment (D, E) = (d·B, e·B). */
export function generateNonces(): { nonces: FrostNonces; commitment: Commitment } {
  const d = randomScalar();
  const e = randomScalar();
  return { nonces: { d, e }, commitment: { D: BASE.multiply(d).toRawBytes(), E: BASE.multiply(e).toRawBytes() } };
}

/** ρ_i = H(i ‖ msg ‖ commitments sorted by nodeId), each commitment as (nodeId ‖ D ‖ E). */
export function computeBindingFactor(nodeId: number, msg: Uint8Array, commitments: FrostCommitment[]): bigint {
  const sorted = [...commitments].sort((a, b) => a.nodeId - b.nodeId);
  const parts = sorted.map((c) => concatBytes(Uint8Array.of(c.nodeId), c.D, c.E));
  return scalarFromBytesLE(sha512(concatBytes(Uint8Array.of(nodeId), msg, ...parts)));
}

/** R = Σ (D_i + ρ_i·E_i) over the commitments of this round. */
export function computeGroupCommitment(msg: Uint8Array, commitments: FrostCommitment[]): Uint8Array {
  const decodePoint = (bytes: Uint8Array) => ed25519.ExtendedPoint.fromHex(bytes);
  const R = commitments
    .map((c) => decodePoint(c.D).add(decodePoint(c.E).multiply(computeBindingFactor(c.nodeId, msg, commitments))))
    .reduce((sum, p) => sum.add(p), ed25519.ExtendedPoint.ZERO);
  return R.toRawBytes();
}

/** The Ed25519 challenge c = SHA-512(R ‖ Y ‖ msg) mod L. */
export function computeChallenge(R: Uint8Array, groupPublicKey: Uint8Array, msg: Uint8Array): bigint {
  return scalarFromBytesLE(sha512(concatBytes(R, groupPublicKey, msg)));
}

/** Signer, round 2: z_i = d_i + ρ_i·e_i + λ_i·s_i·c. */
export function computeSignatureShare(
  nodeId: number,
  nonces: FrostNonces,
  secretKeyShare: bigint,
  msg: Uint8Array,
  commitments: FrostCommitment[],
  groupPublicKey: Uint8Array,
  participants: number[]
): bigint {
  const rho = computeBindingFactor(nodeId, msg, commitments);
  const R = computeGroupCommitment(msg, commitments);
  const c = computeChallenge(R, groupPublicKey, msg);
  const lambda = lagrangeCoefficient(participants, nodeId);
  return mod(nonces.d + rho * nonces.e + lambda * secretKeyShare * c);
}

/** Aggregator: (R ‖ Σ z_i) is a standard Ed25519 signature under the group key. */
export function aggregateSignatureShares(R: Uint8Array, shares: bigint[]): Uint8Array {
  const z = shares.reduce((acc, s) => mod(acc + s), 0n);
  return concatBytes(R, scalarToBytesLE(z));
}

export function verifySignature(signature: Uint8Array, msg: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, msg, publicKey);
  } catch {
    return false;
  }
}
