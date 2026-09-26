import { z } from "zod";
import { base64UrlDecode, base64UrlEncode } from "./base64url.js";
import { bigIntToHex, hexToBigInt } from "./hex.js";

/**
 * The identity node's HTTP API as Zod codecs, one schema per request and response body.
 * Both ends use the same schema: the node decodes the request it receives and encodes the
 * response it sends; a client encodes its request and decodes the node's response.
 *
 *   schema.parse(json)     wire → domain: base64url → bytes, 64 hex digits → bigint
 *   z.encode(schema, obj)  domain → wire
 *
 * The wire form is what `protocol/` specifies; this file is its TypeScript reading.
 */

export const text = z.string("is required").min(1, "must not be empty");

const base64url = text.regex(/^[A-Za-z0-9_-]+$/, "must be base64url without padding");
const byteArray = z.custom<Uint8Array>((value) => value instanceof Uint8Array, "must be bytes");

/** Shamir evaluation point, hashed as one byte in FROST: 0 is the secret itself, 255 the largest that fits. */
export const nodeId = z.int("must be an integer").min(1, "must be between 1 and 255").max(255, "must be between 1 and 255");

/** base64url without padding ↔ bytes, optionally of an exact length. */
export function bytes(length?: number) {
  return z.codec(base64url, byteArray, {
    decode: (value, payload) => {
      let decoded: Uint8Array;
      try {
        decoded = base64UrlDecode(value);
      } catch {
        payload.issues.push({ code: "custom", message: "must be base64url without padding", input: value });
        return new Uint8Array();
      }
      if (length !== undefined && decoded.length !== length) {
        payload.issues.push({ code: "custom", message: `must decode to ${length} bytes, got ${decoded.length}`, input: value });
      }
      return decoded;
    },
    encode: (value) => base64UrlEncode(value),
  });
}

/** A scalar in Z_L: 64 lowercase hex digits, big-endian ↔ bigint. */
export const scalar = z.codec(z.string("is required").regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex digits"), z.bigint(), {
  decode: (hex) => hexToBigInt(hex),
  encode: (value) => bigIntToHex(value),
});

/** A FROST round-1 commitment tagged with its signer: `{ nodeId, D, E }`, points base64url. */
export const commitment = z.object({ nodeId, D: bytes(32), E: bytes(32) });
export const commitments = z.array(commitment, "must be an array");
export const participants = z.array(nodeId, "must be an array");

export const grant = z.enum(["authorization_code", "refresh_token"], 'must be "authorization_code" or "refresh_token"');
export type Grant = z.infer<typeof grant>;

// ---- GET /health ------------------------------------------------------------------

export const healthResponse = z.object({
  status: z.literal("ok"),
  nodeId,
  groupPublicKey: bytes(32),
  /** Where a browser reaches this node for `/register`. */
  publicUrl: text,
});

// ---- POST /register: one user's share for this node, straight from the browser ---------------

export const registerRequest = z.object({
  username: text,
  /** Chosen by the browser; the node refuses one it already holds. */
  sub: text,
  /** k_i */
  toprfKeyShare: scalar,
  /** h_i = H(h, i) */
  h_i: bytes(32),
});
export const registerResponse = z.object({ nodeId });

// ---- POST /commit: FROST round 1 ------------------------------------------------------

export const commitRequest = z.object({ roundId: text });
export const commitResponse = commitment;

// ---- POST /sign-on: TOPRF evaluation + FROST round 2 for the assertion ------------------------

export const signOnRequest = z.object({
  roundId: text,
  request: z.object({
    username: text,
    /** A = r·H1(password), a Ristretto255 point. */
    blinded: bytes(32),
    /** Client randomness the AEAD nonce is derived from. */
    sessionNonce: bytes(),
    cnfJkt: text,
    clientId: text,
    /** An empty scope is a legitimate OAuth request. */
    scope: z.string("must be a string"),
    /** Left off entirely when absent so the signed payload matches; a literal `null` is refused. */
    nonce: z.string("must be a string").optional(),
    iat: z.int("must be an integer"),
    exp: z.int("must be an integer"),
    commitments,
    allParticipants: participants,
  }),
});

export const signOnResponse = z.object({
  nodeId,
  /** B_i = k_i·A */
  toprfPartial: bytes(32),
  /** AEAD_{h_i}(z_i): the node's signature share, readable only with the password. */
  ct_i: bytes(),
  sub: text,
});

// ---- POST /sign: FROST round 2 for the access token and the refresh token ---------------------

export const signRequest = z.object({
  roundId: text,
  refreshRoundId: text,
  request: z
    .object({
      /** `private_key_jwt` assertion of the gateway (RFC 7523): the caller the node charges. */
      clientAssertion: text,
      grant,
      assertion: z.string().optional(),
      refreshToken: z.string().optional(),
      dpopProof: text,
      claims: z.object({ iat: z.int("must be an integer"), exp: z.int("must be an integer"), jti: text }),
      commitments,
      refreshCommitments: commitments,
      allParticipants: participants,
    })
    .refine((r) => (r.grant === "authorization_code" ? !!r.assertion : !!r.refreshToken), {
      message: "assertion (authorization_code) or refreshToken (refresh_token) must not be empty",
    }),
});

/** The plaintext shares of the access token and of the next refresh token. */
export const signResponse = z.object({ nodeId, at: scalar, rt: scalar });

// ---- Types: `Wire` is the JSON form, the plain name the decoded form -----------------------

export type HealthResponse = z.output<typeof healthResponse>;
export type HealthResponseWire = z.input<typeof healthResponse>;
export type RegisterRequest = z.output<typeof registerRequest>;
export type RegisterRequestWire = z.input<typeof registerRequest>;
export type RegisterResponse = z.output<typeof registerResponse>;
export type RegisterResponseWire = z.input<typeof registerResponse>;
export type CommitRequest = z.output<typeof commitRequest>;
export type CommitRequestWire = z.input<typeof commitRequest>;
export type CommitResponse = z.output<typeof commitResponse>;
export type CommitResponseWire = z.input<typeof commitResponse>;
export type SignOnRequest = z.output<typeof signOnRequest>;
export type SignOnRequestWire = z.input<typeof signOnRequest>;
export type SignOnResponse = z.output<typeof signOnResponse>;
export type SignOnResponseWire = z.input<typeof signOnResponse>;
export type SignRequest = z.output<typeof signRequest>;
export type SignRequestWire = z.input<typeof signRequest>;
export type SignResponse = z.output<typeof signResponse>;
export type SignResponseWire = z.input<typeof signResponse>;
