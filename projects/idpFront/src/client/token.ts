import { DPoPKeyPair, createDPoPProof } from "@decentralized-idp/sdk/dpop";

/**
 * `POST /token` as the relying party does it: the credential in a form body and a fresh
 * DPoP proof for this one call in the header. Only the holder of the DPoP key calls it:
 * `../../cli.ts` when it plays the relying party, and the gateway's tests.
 */

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface TokenError {
  error: string;
  error_description: string;
}

export interface TokenRequest {
  /** Where `POST /token` goes. */
  gatewayUrl: string;
  /** The gateway's URL as the browser sees it: `htu` of the DPoP proof. */
  issuer: string;
  dpop: DPoPKeyPair;
  grant: "authorization_code" | "refresh_token";
  /** The assertion (authorization code) or the refresh token. */
  credential: string;
  /** Unix seconds; defaults to the wall clock. */
  now?: number;
}

export async function requestToken(request: TokenRequest): Promise<{ status: number; body: TokenResponse | TokenError }> {
  const now = request.now ?? Math.floor(Date.now() / 1000);
  const field = request.grant === "authorization_code" ? "code" : "refresh_token";
  const res = await fetch(`${request.gatewayUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", DPoP: createDPoPProof(request.dpop, "POST", `${request.issuer}/token`, now) },
    body: new URLSearchParams({ grant_type: request.grant, [field]: request.credential }),
  });
  return { status: res.status, body: (await res.json()) as TokenResponse | TokenError };
}
