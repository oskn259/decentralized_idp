import crypto from "node:crypto";
import { ristretto255 } from "@noble/curves/ed25519";
import { REFRESH_TOKEN_LIFETIME_SECONDS } from "../../src/domain/service/credential.js";
import { commit } from "../../src/domain/usecase/commit.js";
import { IdentityNode } from "../../src/domain/usecase/identity-node.js";
import { TokenRequest, issueTokens } from "../../src/domain/usecase/issue-tokens.js";
import { SignOnInput, signOn } from "../../src/domain/usecase/sign-on.js";
import { DEFAULT_KEY_ID } from "../../src/domain/value/node-identity.js";
import { decryptShare, newDPoPKeyPair } from "./client.js";
import { createDPoPProof, DPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { aggregateSignatureShares, computeGroupCommitment, FrostCommitment } from "@decentralized-idp/sdk/frost";
import { assembleJwt, createSigningInput, decodeJwt } from "@decentralized-idp/sdk/jwt";
import { SignOnResponse } from "@decentralized-idp/sdk/node-api";
import { accessTokenJwt, assertionJwt, credentialClaimsOf, refreshTokenJwt } from "@decentralized-idp/sdk/tokens";
import { Blinding, blind, finalize, unblind } from "@decentralized-idp/sdk/toprf";

/**
 * In-process driver: plays the gateway's relay role and the client's aggregation role
 * against `commit`/`signOn`/`issueTokens` directly, with no HTTP hop. Lets a usecase test
 * drive many nodes sharing one `FakeClock` and see exact rejection messages.
 */

/** Round 1, in process: every node opens a round and returns its commitment. */
export function openRound(nodes: IdentityNode[], roundId: string): FrostCommitment[] {
  return nodes.map((n) => ({ nodeId: n.identity.nodeId, ...commit(n, roundId) }));
}

export interface InProcSignOn {
  roundId: string;
  commitments: FrostCommitment[];
  input: SignOnInput;
  blinding: Blinding;
  dpop: { keyPair: DPoPKeyPair; cnfJkt: string };
  /**
   * The `iss`/`aud` the nodes sign is their own configured issuer, never a request field.
   * `aggregateSignOn` rebuilds the signed payload from this; if it differs from the nodes'
   * issuer, the AEAD decrypt fails the same way a wrong password does.
   */
  issuer: string;
}

export interface SignOnOptions {
  username: string;
  password: string;
  issuer: string;
  clientId?: string;
  scope?: string;
  nonce?: string;
  lifetimeSeconds?: number;
  iat?: number;
  dpop?: { keyPair: DPoPKeyPair; cnfJkt: string };
  roundId?: string;
  commitments?: FrostCommitment[];
  /** Merged over the built input last, so a test can smuggle in or override any field. */
  overrides?: Partial<SignOnInput>;
}

export function prepareSignOn(nodes: IdentityNode[], options: SignOnOptions): InProcSignOn {
  const roundId = options.roundId ?? crypto.randomUUID();
  const commitments = options.commitments ?? openRound(nodes, roundId);
  const { blinding, blinded } = blind(options.password);
  const dpop = options.dpop ?? newDPoPKeyPair();
  // The nodes check freshness against their own `FakeClock`, not wall time.
  const iat = options.iat ?? nodes[0].clock.nowSeconds();
  const exp = iat + (options.lifetimeSeconds ?? 30);

  const input: SignOnInput = {
    roundId,
    username: options.username,
    blinded: blinded.toRawBytes(),
    sessionNonce: crypto.randomBytes(16),
    cnfJkt: dpop.cnfJkt,
    clientId: options.clientId ?? "demo_client",
    scope: options.scope ?? "openid profile",
    iat,
    exp,
    commitments,
    allParticipants: nodes.map((n) => n.identity.nodeId),
    ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
    ...(options.overrides ?? {}),
  };
  return { roundId, commitments, input, blinding, dpop, issuer: options.issuer };
}

/** Runs round 2 on every node, handing each its own commitment set. */
export function runSignOn(nodes: IdentityNode[], round: InProcSignOn): SignOnResponse[] {
  return nodes.map((n) => signOn(n, round.input));
}

export interface AggregateOptions {
  round: InProcSignOn;
  responses: SignOnResponse[];
  password: string;
  /** Defaults to the sub the nodes reported. */
  sub?: string;
  /** Defaults to the full commitment set from round 1. */
  commitments?: FrostCommitment[];
  /** AAD to decrypt against, when deliberately mismatched. */
  aadOverride?: Uint8Array;
}

/** Client-side finish: unblind, decrypt every `ct_i`, aggregate, assemble the assertion. */
export function aggregateSignOn(options: AggregateOptions): { assertion: string; signingInput: Uint8Array } {
  const { round, responses, password } = options;
  const sub = options.sub ?? responses[0].sub;
  const jwt = assertionJwt(
    { issuer: round.issuer, keyId: DEFAULT_KEY_ID },
    sub,
    {
      clientId: round.input.clientId,
      scope: round.input.scope,
      cnfJkt: round.input.cnfJkt,
      nonce: round.input.nonce,
      iat: round.input.iat,
      exp: round.input.exp,
    }
  );
  const { signingInput, headerB64, payloadB64 } = createSigningInput(jwt);
  const aad = options.aadOverride ?? signingInput;

  const partials = responses.map((r) => ({ id: r.nodeId, point: ristretto255.Point.fromBytes(r.toprfPartial) }));
  const h = finalize(password, unblind(round.blinding, partials));
  const shares = responses.map((r) => decryptShare(h, round.input.sessionNonce, r.nodeId, r.ct_i, aad));

  const commitments = options.commitments ?? round.commitments;
  const R = computeGroupCommitment(signingInput, commitments);
  const signature = aggregateSignatureShares(R, shares);
  return { assertion: assembleJwt(headerB64, payloadB64, signature), signingInput };
}

/** Sign-on plus aggregation: the assertion a client walks away with. */
export function assertionFor(
  nodes: IdentityNode[],
  options: SignOnOptions
): { round: InProcSignOn; assertion: string; sub: string } {
  const round = prepareSignOn(nodes, options);
  const responses = runSignOn(nodes, round);
  const { assertion } = aggregateSignOn({ round, responses, password: options.password });
  return { round, assertion, sub: responses[0].sub };
}

export interface SignTokensOptions {
  /** The assertion or refresh token to spend. */
  credential: string;
  dpopKeyPair: DPoPKeyPair;
  claims: { iat: number; exp: number; jti: string };
  tokenEndpoint: string;
  grant?: "authorization_code" | "refresh_token";
  /** Opens the access and refresh rounds as one round, to exercise nonce-reuse rejection. */
  sameRound?: boolean;
  proofHtu?: string;
  proofHtm?: string;
  /** `iat` the DPoP proof itself carries, defaulting to `claims.iat`. */
  dpopIat?: number;
}

/** Aggregates one set of shares into a finished JWT. */
function assemble(
  parts: { signingInput: Uint8Array; headerB64: string; payloadB64: string },
  commitments: FrostCommitment[],
  shares: bigint[]
): string {
  const R = computeGroupCommitment(parts.signingInput, commitments);
  return assembleJwt(parts.headerB64, parts.payloadB64, aggregateSignatureShares(R, shares));
}

/** Runs `/sign`-equivalent round 2 on every node and assembles both tokens. */
export function signTokens(
  nodes: IdentityNode[],
  options: SignTokensOptions
): { access_token: string; refresh_token: string; shares: bigint[]; refreshShares: bigint[] } {
  const { credential, dpopKeyPair, claims, tokenEndpoint } = options;
  const accessRoundId = crypto.randomUUID();
  const refreshRoundId = options.sameRound ? accessRoundId : crypto.randomUUID();
  const commitments = openRound(nodes, accessRoundId);
  const refreshCommitments = options.sameRound ? commitments : openRound(nodes, refreshRoundId);

  const input: TokenRequest = {
    accessRoundId,
    refreshRoundId,
    grant: options.grant ?? "authorization_code",
    credential,
    dpopProof: createDPoPProof(dpopKeyPair, options.proofHtm ?? "POST", options.proofHtu ?? tokenEndpoint, options.dpopIat ?? claims.iat),
    claims,
    commitments,
    refreshCommitments,
    allParticipants: nodes.map((n) => n.identity.nodeId),
  };
  const responses = nodes.map((n) => issueTokens(n, input));

  // The nodes signed the claims the credential carries, so the tokens are rebuilt from it,
  // not from what the test asked for. The refresh lifetime is fixed by the node.
  const { payload } = decodeJwt(credential);
  const by = { issuer: payload.iss as string, keyId: DEFAULT_KEY_ID };
  const atParts = createSigningInput(accessTokenJwt(by, credentialClaimsOf(payload), claims));
  const rtParts = createSigningInput(refreshTokenJwt(by, credentialClaimsOf(payload), claims.iat, claims.iat + REFRESH_TOKEN_LIFETIME_SECONDS));

  const shares = responses.map((r) => r.accessShare);
  const refreshShares = responses.map((r) => r.refreshShare);
  return {
    access_token: assemble(atParts, commitments, shares),
    refresh_token: assemble(rtParts, refreshCommitments, refreshShares),
    shares,
    refreshShares,
  };
}
