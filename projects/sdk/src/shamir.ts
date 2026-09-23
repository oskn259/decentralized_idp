import { invert, mod, randomScalar } from "./scalar.js";

/** One Shamir share: the polynomial evaluated at participant `id` (1-based). */
export interface Share {
  id: number;
  value: bigint;
}

/** f(x) = secret + c_1·x + ... + c_{t-1}·x^{t-1}; participant `id` holds f(id). */
export function splitSecret(secret: bigint, threshold: number, total: number): Share[] {
  if (threshold < 1 || threshold > total) {
    throw new Error(`Invalid threshold: must satisfy 1 <= threshold (${threshold}) <= total (${total})`);
  }
  const coefficients = Array.from({ length: threshold - 1 }, () => randomScalar());
  // Horner's method, highest coefficient first, the secret last.
  const f = (x: bigint): bigint => {
    const higher = coefficients.reduceRight((acc, c) => mod(acc * x + c), 0n);
    return mod(higher * x + secret);
  };
  return Array.from({ length: total }, (_, i) => ({ id: i + 1, value: f(BigInt(i + 1)) }));
}

/** λ_i(0) = ∏_{j ≠ i} x_j / (x_j − x_i): the weight of share i when interpolating at 0. */
export function lagrangeCoefficient(ids: number[], targetId: number): bigint {
  const xi = BigInt(targetId);
  const others = ids.filter((j) => j !== targetId).map((j) => BigInt(j));
  const numerator = others.reduce((product, xj) => mod(product * xj), 1n);
  const denominator = others.reduce((product, xj) => mod(product * (xj - xi)), 1n);
  return mod(numerator * invert(denominator));
}

/** secret = Σ λ_i(0)·y_i, from at least `threshold` shares of distinct participants. */
export function combineShares(shares: Share[]): bigint {
  if (shares.length === 0) {
    throw new Error("At least one share is required to combine");
  }
  const ids = shares.map((s) => s.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Duplicate participant IDs found in shares");
  }
  return shares.reduce((secret, share) => mod(secret + lagrangeCoefficient(ids, share.id) * share.value), 0n);
}
