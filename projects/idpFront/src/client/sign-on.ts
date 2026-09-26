import { aeadDecrypt, deriveAeadNonce } from "@decentralized-idp/sdk/aead";
import { base64UrlDecode, base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { aggregateSignatureShares, computeGroupCommitment } from "@decentralized-idp/sdk/frost";
import { bigIntToHex } from "@decentralized-idp/sdk/hex";
import { assembleJwt, createSigningInput } from "@decentralized-idp/sdk/jwt";
import { AssertionRequest, assertionJwt } from "@decentralized-idp/sdk/tokens";
import { blind, deriveServerKey, finalize, unblind } from "@decentralized-idp/sdk/toprf";
import { ristretto255 } from "@noble/curves/ed25519";

/** The assertion is the authorization code; a node signs none that lives longer than this. */
export const ASSERTION_LIFETIME_SECONDS = 30;
/** `kid` of the group key, as the gateway publishes it. */
export const KEY_ID = "pasta-group-key-1";

export interface SignOnRequest {
  /** Base URL of the gateway; `""` when the page is served by the gateway itself. */
  gatewayUrl: string;
  /** The gateway's URL as this browser sees it: `iss` and `aud` of the assertion. */
  issuer: string;
  username: string;
  password: string;
  clientId: string;
  scope: string;
  /** The relying party's DPoP thumbprint, carried through `/authorize`. The assertion binds to it. */
  cnfJkt: string;
  /** The challenge `c` from `/authorize`, signed in as the assertion's nonce. */
  nonce: string;
  /** Unix seconds; defaults to the wall clock. */
  now?: number;
  /** Receives the browser column of the demo trace, one line at a time. */
  log?: (line: string) => void;
  /** Told as each node's share decrypts here, and when the shares add up to the assertion. */
  progress?: SignOnProgress;
}

export interface SignOnProgress {
  /** The blinded password is on its way to the gateway. */
  sent(): void;
  /** The gateway relayed it and every node's encrypted share came back in one answer. */
  sharesReceived(nodeIds: number[]): void;
  decrypted(nodeId: number): void;
  assembled(nodeIds: number[]): void;
}

/** The gateway's answer to `POST /api/pasta/sign-on`: one commitment and one share per node. */
interface SignOnResponse {
  commitments: SigningCommitment[];
  shares: EncryptedShare[];
}

/** The node's FROST nonce commitments (D_i, E_i) for this signature. */
interface SigningCommitment {
  nodeId: number;
  D: string;
  E: string;
}

interface EncryptedShare {
  nodeId: number;
  /** B_i = k_i·A */
  toprfPartial: string;
  /** The node's FROST signature share z_i, AEAD-encrypted under h_i. */
  ct_i: string;
  sub: string;
}

/**
 * The browser's half of PASTA: turns a password into the authentication assertion without
 * the password ever leaving this function.
 *
 * 1. Blind: A = r·H1(pw). Only A travels.
 * 2. Each node answers B_i = k_i·A and its FROST share encrypted under h_i.
 * 3. Unblind and finalize to h, derive every h_i, decrypt every share. A wrong password
 *    fails here, at an AEAD tag — the nodes never learn whether it was right.
 * 4. Add the shares up into the group signature and assemble the JWT.
 */
export async function signOn(request: SignOnRequest): Promise<string> {
  const log = request.log ?? (() => {});
  const now = request.now ?? Math.floor(Date.now() / 1000);
  const claims: AssertionRequest = {
    clientId: request.clientId,
    scope: request.scope,
    cnfJkt: request.cnfJkt,
    nonce: request.nonce,
    iat: now,
    exp: now + ASSERTION_LIFETIME_SECONDS,
  };

  const { blinding, blinded } = blind(request.password);
  const sessionNonce = crypto.getRandomValues(new Uint8Array(16));
  const A = base64UrlEncode(blinded.toRawBytes());
  log(
    `[browser] sign-on   user=${request.username} nonce=${request.nonce}  → r ${short(bigIntToHex(blinding.r))}  ` +
      `A=r·H1(pw) ${short(A)}  jkt(rp) ${short(request.cnfJkt)}  nonce_s ${short(base64UrlEncode(sessionNonce))}`
  );

  request.progress?.sent();
  const response = await requestShares(request, A, sessionNonce, claims, log);
  request.progress?.sharesReceived(response.shares.map((s) => s.nodeId));
  log(`[browser]           ← B_i×${response.shares.length} ct_i×${response.shares.length} (D,E)×${response.commitments.length}`);

  const partials = response.shares.map((s) => ({ id: s.nodeId, point: ristretto255.Point.fromBytes(base64UrlDecode(s.toprfPartial)) }));
  const h = finalize(request.password, unblind(blinding, partials));

  // The same bytes every node signed and used as AEAD associated data. `sub` comes from the
  // nodes' user records; every node holds the same users, so any share's `sub` is the one.
  const { signingInput, headerB64, payloadB64 } = createSigningInput(
    assertionJwt({ issuer: request.issuer, keyId: KEY_ID }, response.shares[0].sub, claims)
  );
  const signatureShares = response.shares.map((s) => {
    const z = decryptShare(s, h, sessionNonce, signingInput, log);
    request.progress?.decrypted(s.nodeId);
    return z;
  });

  const commitments = response.commitments.map((k) => ({ nodeId: k.nodeId, D: base64UrlDecode(k.D), E: base64UrlDecode(k.E) }));
  const R = computeGroupCommitment(signingInput, commitments);
  const assertion = assembleJwt(headerB64, payloadB64, aggregateSignatureShares(R, signatureShares));
  request.progress?.assembled(response.shares.map((s) => s.nodeId));
  log(
    `[browser]           → h=finalize(pw, unblind(r,B_i))  h_i×${signatureShares.length}  z_i=dec(ct_i)×${signatureShares.length} ` +
      `${signatureShares.map((z) => short(bigIntToHex(z))).join(" ")}  R ${short(base64UrlEncode(R))}  σ=Σz_i  assertion ${short(assertion)} ✔ assembled only here`
  );
  return assertion;
}

/** `POST /api/pasta/sign-on`. The gateway's error text becomes the thrown error. */
async function requestShares(
  request: SignOnRequest,
  blinded: string,
  sessionNonce: Uint8Array,
  claims: AssertionRequest,
  log: (line: string) => void
): Promise<SignOnResponse> {
  const res = await fetch(`${request.gatewayUrl}/api/pasta/sign-on`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: request.username, blinded, sessionNonce: base64UrlEncode(sessionNonce), ...claims }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error: string };
    log(`[browser] ✖ sign-on failed: ${body.error}`);
    throw new Error(body.error);
  }
  return (await res.json()) as SignOnResponse;
}

/** Decrypts one node's z_i under h_i. Only a wrong password breaks the AEAD tag. */
function decryptShare(share: EncryptedShare, h: Uint8Array, sessionNonce: Uint8Array, signingInput: Uint8Array, log: (line: string) => void): bigint {
  let plain: Uint8Array;
  try {
    plain = aeadDecrypt(deriveServerKey(h, share.nodeId), deriveAeadNonce(sessionNonce, share.nodeId), base64UrlDecode(share.ct_i), signingInput);
  } catch {
    log(`[browser] ✖ sign-on failed: ct_${share.nodeId} decrypt failed → wrong password (nodes cannot tell)`);
    throw new Error("wrong password: a share did not decrypt");
  }
  const { z_i } = JSON.parse(new TextDecoder().decode(plain)) as { z_i: string };
  return BigInt(z_i);
}

/** First 8 characters of a per-session value. Never called on the password, h or h_i. */
function short(value: string): string {
  return value.slice(0, 8);
}
