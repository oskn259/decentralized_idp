import crypto from "node:crypto";
import { ed25519, ristretto255 } from "@noble/curves/ed25519";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { MAX_ASSERTION_LIFETIME_SECONDS, REFRESH_TOKEN_LIFETIME_SECONDS } from "../../src/domain/service/credential.js";
import { DEFAULT_KEY_ID } from "../../src/domain/value/node-identity.js";
import { readFixtureJson } from "./build-node.js";
import { JsonResponse, RunningNode, postJson, postJsonOrThrow } from "./http-server.js";
import { aeadDecrypt, deriveAeadNonce } from "@decentralized-idp/sdk/aead";
import { base64UrlDecode, base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { calculateJwkThumbprint, createDPoPProof, DPoPKeyPair, exportDPoPJwk, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { aggregateSignatureShares, computeGroupCommitment, FrostCommitment } from "@decentralized-idp/sdk/frost";
import { assembleJwt, createSigningInput, decodeJwt as decodeJwtParts } from "@decentralized-idp/sdk/jwt";
import { CommitResponseWire, SignOnResponseWire, SignResponseWire } from "@decentralized-idp/sdk/node-api";
import { bigIntToHex } from "@decentralized-idp/sdk/hex";
import { UserShare, createUserShares } from "@decentralized-idp/sdk/register";
import { assertionJwt } from "@decentralized-idp/sdk/tokens";
import { blind, deriveServerKey, finalize, unblind } from "@decentralized-idp/sdk/toprf";

/**
 * The gateway's client roles over real HTTP: the browser half registers a user by sending
 * each node its share directly, and assembles the assertion by decrypting every `ct_i` and
 * aggregating the FROST shares; the gateway half holds the DPoP key and spends that
 * assertion, or a refresh token, for an access and a refresh token, authenticating itself
 * to each node and paying for `/sign` when a node asks.
 */

export interface RegisterParams {
  nodes: RunningNode[];
  username: string;
  password: string;
  sub: string;
}

/** One share per fixture node, for the group's threshold. */
export function fixtureUserShares(password: string): UserShare[] {
  const { threshold, total } = readFixtureJson("group.json");
  return createUserShares(password, threshold, total);
}

/** A `/register` body carrying `share` in plaintext, as the browser sends it. */
export function registerBody(share: UserShare, username: string, sub: string): Record<string, unknown> {
  return { username, sub, toprfKeyShare: bigIntToHex(share.toprfKeyShare.value), h_i: base64UrlEncode(share.h_i) };
}

/** Registration as the browser does it: `/register` on every node, each with its own share. */
export async function registerOverHttp(params: RegisterParams): Promise<void> {
  const shares = fixtureUserShares(params.password);
  await Promise.all(
    params.nodes.map((node) => {
      const share = shares.find((s) => s.nodeId === node.nodeId)!;
      return postJsonOrThrow(node.url, "/register", registerBody(share, params.username, params.sub));
    })
  );
}

export function newDPoPKeyPair(): { keyPair: DPoPKeyPair; cnfJkt: string } {
  const keyPair = generateDPoPKeyPair();
  return { keyPair, cnfJkt: calculateJwkThumbprint(exportDPoPJwk(keyPair.publicKey)) };
}

function decodeCommitments(wire: CommitResponseWire[]): FrostCommitment[] {
  return wire.map((c) => ({ nodeId: c.nodeId, D: base64UrlDecode(c.D), E: base64UrlDecode(c.E) }));
}

/** Round 1: ask every participant for a FROST commitment over HTTP. */
export async function collectCommitments(nodes: RunningNode[], roundId: string): Promise<CommitResponseWire[]> {
  return Promise.all(nodes.map((n) => postJsonOrThrow(n.url, "/commit", { roundId })));
}

/**
 * Decrypts one node's signature share `z_i` from `ct_i` with the key `h_i` derived from the
 * recovered `h`. Any AEAD failure reads as a wrong password: the node never checks it.
 */
export function decryptShare(h: Uint8Array, sessionNonce: Uint8Array, nodeId: number, ct_i: Uint8Array, aad: Uint8Array): bigint {
  let plaintext: Uint8Array;
  try {
    plaintext = aeadDecrypt(deriveServerKey(h, nodeId), deriveAeadNonce(sessionNonce, nodeId), ct_i, aad);
  } catch {
    throw new Error(`Failed to decrypt share from node ${nodeId}. Invalid password or corrupted share.`);
  }
  return BigInt(JSON.parse(Buffer.from(plaintext).toString("utf8")).z_i);
}

export interface ClientSession {
  assertion: string;
  sub: string;
  cnfJkt: string;
  dpopKeyPair: DPoPKeyPair;
  clientId: string;
  scope: string;
  issuer: string;
}

export interface SignOnParams {
  nodes: RunningNode[];
  username: string;
  password: string;
  clientId: string;
  issuer: string;
  scope?: string;
  nonce?: string;
  lifetimeSeconds?: number;
  dpop?: { keyPair: DPoPKeyPair; cnfJkt: string };
  /** Overrides the `sub` the client assumes, to show a spoofed subject cannot decrypt. */
  subOverride?: string;
  /** Reuses a round already opened with `collectCommitments`. */
  round?: { roundId: string; commitments: CommitResponseWire[] };
  /**
   * `iat` the client stamps the request with, defaulting to real wall time. Pass the
   * servers' own `FakeClock.nowSeconds()` when they were not built on the system clock.
   */
  now?: number;
}

/** Full sign-on: `/commit` on every node, then `/sign-on`, then local decrypt + aggregate. */
export async function signOnOverHttp(params: SignOnParams): Promise<ClientSession> {
  const dpop = params.dpop ?? newDPoPKeyPair();
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const exp = now + (params.lifetimeSeconds ?? MAX_ASSERTION_LIFETIME_SECONDS);
  const roundId = params.round?.roundId ?? crypto.randomUUID();
  const scope = params.scope ?? "openid profile";
  const commitments = params.round?.commitments ?? (await collectCommitments(params.nodes, roundId));

  const { blinding, blinded } = blind(params.password);
  const sessionNonce = crypto.randomBytes(16);

  const request: Record<string, unknown> = {
    username: params.username,
    blinded: base64UrlEncode(blinded.toRawBytes()),
    sessionNonce: base64UrlEncode(sessionNonce),
    cnfJkt: dpop.cnfJkt,
    clientId: params.clientId,
    scope,
    iat: now,
    exp,
    commitments,
    allParticipants: params.nodes.map((n) => n.nodeId),
  };
  if (params.nonce !== undefined) {
    request.nonce = params.nonce;
  }

  const responses: SignOnResponseWire[] = await Promise.all(params.nodes.map((n) => postJsonOrThrow(n.url, "/sign-on", { roundId, request })));

  const sub = params.subOverride ?? responses[0].sub;
  const jwt = assertionJwt(
    { issuer: params.issuer, keyId: DEFAULT_KEY_ID },
    sub,
    { clientId: params.clientId, scope, cnfJkt: dpop.cnfJkt, nonce: params.nonce, iat: now, exp }
  );
  const { signingInput, headerB64, payloadB64 } = createSigningInput(jwt);

  const partials = responses.map((r) => ({ id: r.nodeId, point: ristretto255.Point.fromBytes(base64UrlDecode(r.toprfPartial)) }));
  const h = finalize(params.password, unblind(blinding, partials));
  const shares = responses.map((r) => decryptShare(h, sessionNonce, r.nodeId, base64UrlDecode(r.ct_i), signingInput));

  const R = computeGroupCommitment(signingInput, decodeCommitments(commitments));
  const signature = aggregateSignatureShares(R, shares);

  return {
    assertion: assembleJwt(headerB64, payloadB64, signature),
    sub,
    cnfJkt: dpop.cnfJkt,
    dpopKeyPair: dpop.keyPair,
    clientId: params.clientId,
    scope,
    issuer: params.issuer,
  };
}

export interface SignParams {
  nodes: RunningNode[];
  session: ClientSession;
  /** Which credential to spend. Defaults to the session's assertion. */
  grant?: "authorization_code" | "refresh_token";
  /** The refresh token to spend, for a `refresh_token` grant. */
  refreshToken?: string;
  /** Replaces the credential presented, to exercise the node's verification. */
  assertionOverride?: string;
  lifetimeSeconds?: number;
  jti?: string;
  /** Signs the DPoP proof for a different URL, to exercise node-side rejection. */
  proofHtuOverride?: string;
  /** Signs the DPoP proof with another key, to exercise the jkt binding. */
  keyPairOverride?: DPoPKeyPair;
  /** Replaces the whole proof, to exercise replay or staleness. */
  dpopProofOverride?: string;
  /** `iat` the DPoP proof itself carries, defaulting to now. */
  dpopIatOverride?: number;
  /** Overrides `iat` / `exp` / `jti` of the token claims, for the range checks. */
  claimsOverride?: Partial<{ iat: number; exp: number; jti: string }>;
  /** Opens the access and refresh rounds as one round, to exercise nonce reuse rejection. */
  sameRound?: boolean;
  /** `iat` the client stamps `claims` and the DPoP proof with, defaulting to real wall time. */
  now?: number;
}

export interface SignAttempt {
  accessRoundId: string;
  refreshRoundId: string;
  commitments: CommitResponseWire[];
  refreshCommitments: CommitResponseWire[];
  request: Record<string, unknown>;
  atPayload: Record<string, unknown>;
  rtPayload: Record<string, unknown>;
}

/** Reads the identity claims out of a credential, the way the nodes do. */
function credentialClaims(credential: string): { sub: string; client_id: string; scope: string; jkt: string } {
  // A deliberately malformed credential still has to reach the node, so the test can see
  // the node's own refusal rather than one raised here.
  let payload: any = {};
  try {
    payload = JSON.parse(Buffer.from(credential.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    payload = {};
  }
  return {
    sub: payload.sub ?? "",
    client_id: payload.client_id ?? "",
    scope: payload.scope ?? "",
    jkt: payload.cnf?.jkt ?? "",
  };
}

/** The gateway of `fixtures/gateways.json`, with its private key from `fixtures/gateway.json`. */
const GATEWAY = readFixtureJson("gateway.json");
export const GATEWAY_ID: string = GATEWAY.client_id;
const GATEWAY_KEY = base64UrlDecode(GATEWAY.key.d);

/** The gateway's `private_key_jwt` for `/sign` on `node`, stamped with the node's own clock. */
export function clientAssertion(node: RunningNode, overrides: Record<string, unknown> = {}, secretKey: Uint8Array = GATEWAY_KEY): string {
  const iat = node.node.clock.nowSeconds();
  const { signingInput, headerB64, payloadB64 } = createSigningInput({
    header: { alg: "EdDSA" },
    payload: { iss: GATEWAY_ID, sub: GATEWAY_ID, aud: node.node.identity.publicUrl, jti: crypto.randomUUID(), iat, exp: iat + 60, ...overrides },
  });
  return assembleJwt(headerB64, payloadB64, ed25519.sign(signingInput, secretKey));
}

/** A `/sign` body carrying `clientAssertion` (the gateway's own, for `node`, unless given). */
export function withAssertion(node: RunningNode, body: Record<string, any>, assertion: string = clientAssertion(node)): Record<string, unknown> {
  return { ...body, request: { ...body.request, clientAssertion: assertion } };
}

/** `PAYMENT-SIGNATURE` answering a 402: its first requirement, accepted as is. The fake settlers ignore `payload`. */
export function paymentSignature(refused: JsonResponse): string {
  const required = decodePaymentRequiredHeader(refused.headers.get("PAYMENT-REQUIRED") ?? "");
  return encodePaymentSignatureHeader({ x402Version: 2, accepted: required.accepts[0], payload: {} });
}

/** `/sign` as the gateway sends it: with its client assertion, paying and retrying once on a 402. */
export async function postSign(node: RunningNode, body: Record<string, unknown>): Promise<JsonResponse> {
  const signed = withAssertion(node, body);
  const first = await postJson(node.url, "/sign", signed);
  if (first.status !== 402) return first;
  return postJson(node.url, "/sign", signed, { headers: { "PAYMENT-SIGNATURE": paymentSignature(first) } });
}

/** Opens both rounds and builds the `/sign` request the gateway would send. */
export async function prepareSign(params: SignParams): Promise<SignAttempt> {
  const session = params.session;
  const grant = params.grant ?? "authorization_code";
  const accessRoundId = crypto.randomUUID();
  const refreshRoundId = params.sameRound ? accessRoundId : crypto.randomUUID();
  const commitments = await collectCommitments(params.nodes, accessRoundId);
  const refreshCommitments = params.sameRound ? commitments : await collectCommitments(params.nodes, refreshRoundId);

  const now = params.now ?? Math.floor(Date.now() / 1000);
  const claims = {
    iat: now,
    exp: now + (params.lifetimeSeconds ?? 3600),
    jti: params.jti ?? crypto.randomUUID(),
    ...(params.claimsOverride ?? {}),
  };

  const credential =
    params.assertionOverride ?? (grant === "refresh_token" ? params.refreshToken ?? "" : session.assertion);

  const dpopProof =
    params.dpopProofOverride ??
    createDPoPProof(
      params.keyPairOverride ?? session.dpopKeyPair,
      "POST",
      params.proofHtuOverride ?? `${session.issuer}/token`,
      params.dpopIatOverride ?? now
    );

  const request: Record<string, unknown> = {
    grant,
    dpopProof,
    claims,
    commitments,
    refreshCommitments,
    allParticipants: params.nodes.map((n) => n.nodeId),
  };
  if (grant === "authorization_code") {
    request.assertion = credential;
  } else {
    request.refreshToken = credential;
  }

  // The nodes read these out of the credential, so the test does too rather than assuming
  // what it asked for. The refresh token's lifetime is fixed by the node, not selectable.
  const identity = credentialClaims(credential);
  const refreshExp = claims.iat + REFRESH_TOKEN_LIFETIME_SECONDS;

  return {
    accessRoundId,
    refreshRoundId,
    commitments,
    refreshCommitments,
    request,
    atPayload: {
      iss: session.issuer,
      sub: identity.sub,
      aud: identity.client_id,
      scope: identity.scope,
      cnf: { jkt: identity.jkt },
      iat: claims.iat,
      exp: claims.exp,
      jti: claims.jti,
    },
    rtPayload: {
      iss: session.issuer,
      sub: identity.sub,
      cnf: { jkt: identity.jkt },
      client_id: identity.client_id,
      scope: identity.scope,
      iat: claims.iat,
      exp: refreshExp,
    },
  };
}

/** The `/sign` body for an attempt, as one node receives it. */
export function signBody(attempt: SignAttempt): Record<string, unknown> {
  return { roundId: attempt.accessRoundId, refreshRoundId: attempt.refreshRoundId, request: attempt.request };
}

/** Aggregates one set of hex shares into a finished JWT. */
function assemble(
  parts: { signingInput: Uint8Array; headerB64: string; payloadB64: string },
  commitments: CommitResponseWire[],
  shares: string[]
): string {
  const R = computeGroupCommitment(parts.signingInput, decodeCommitments(commitments));
  const signature = aggregateSignatureShares(
    R,
    shares.map((z) => BigInt("0x" + z))
  );
  return assembleJwt(parts.headerB64, parts.payloadB64, signature);
}

/** Full issuance: two rounds of `/commit`, `/sign` on every node, then aggregate both JWTs. */
export async function signOverHttp(params: SignParams): Promise<{
  access_token: string;
  refresh_token: string;
  atPayload: Record<string, unknown>;
  rtPayload: Record<string, unknown>;
  shares: string[];
  refreshShares: string[];
}> {
  const attempt = await prepareSign(params);
  const responses: SignResponseWire[] = await Promise.all(
    params.nodes.map(async (n) => {
      const res = await postSign(n, signBody(attempt));
      if (res.status !== 200) throw new Error(`POST /sign -> ${res.status}: ${res.text}`);
      return res.body;
    })
  );

  const atParts = createSigningInput({ header: { alg: "EdDSA", typ: "at+jwt", kid: DEFAULT_KEY_ID }, payload: attempt.atPayload });
  const rtParts = createSigningInput({ header: { alg: "EdDSA", typ: "refresh+jwt", kid: DEFAULT_KEY_ID }, payload: attempt.rtPayload });

  return {
    access_token: assemble(atParts, attempt.commitments, responses.map((r) => r.at)),
    refresh_token: assemble(rtParts, attempt.refreshCommitments, responses.map((r) => r.rt)),
    atPayload: attempt.atPayload,
    rtPayload: attempt.rtPayload,
    shares: responses.map((r) => r.at),
    refreshShares: responses.map((r) => r.rt),
  };
}

/** The sdk's decode, loosely typed so a test can read any claim without a cast. */
export function decodeJwt(token: string): { header: any; payload: any } {
  return decodeJwtParts(token);
}
