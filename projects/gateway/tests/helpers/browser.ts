import { DPoPKeyPair, calculateJwkThumbprint, exportDPoPJwk, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { signOn as sdkSignOn } from "../../../idpFront/src/client/sign-on.js";
import { TokenError, TokenResponse, requestToken } from "../../../rp/src/token.js";

/**
 * The browser against a running gateway, played by the real clients: the login page's
 * `signOn` assembles the assertion, the relying party's `requestToken` calls `/token`.
 */

export interface Browser {
  gatewayUrl: string;
  issuer: string;
  clientId: string;
  scope: string;
  dpop: DPoPKeyPair;
  jkt: string;
}

export function openBrowser(gatewayUrl: string, issuer = gatewayUrl, clientId = "demo_client", scope = "openid profile"): Browser {
  const dpop = generateDPoPKeyPair();
  return { gatewayUrl, issuer, clientId, scope, dpop, jkt: calculateJwkThumbprint(exportDPoPJwk(dpop.publicKey)) };
}

/** Returns the assertion (= authorization code). Throws when a share does not decrypt: wrong password. */
export function signOn(browser: Browser, username: string, password: string, nonce: string, now?: number): Promise<string> {
  return sdkSignOn({
    gatewayUrl: browser.gatewayUrl,
    issuer: browser.issuer,
    username,
    password,
    clientId: browser.clientId,
    scope: browser.scope,
    cnfJkt: browser.jkt,
    nonce,
    now,
  });
}

export async function token(
  browser: Browser,
  grant: "authorization_code" | "refresh_token",
  credential: string,
  options: { proof?: string; now?: number } = {}
): Promise<{ status: number; body: TokenResponse & Partial<TokenError> }> {
  if (options.proof === undefined) {
    const res = await requestToken({ gatewayUrl: browser.gatewayUrl, issuer: browser.issuer, dpop: browser.dpop, grant, credential, now: options.now });
    return res as { status: number; body: TokenResponse & Partial<TokenError> };
  }
  const res = await fetch(`${browser.gatewayUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", DPoP: options.proof },
    body: new URLSearchParams({ grant_type: grant, [grant === "authorization_code" ? "code" : "refresh_token"]: credential }),
  });
  return { status: res.status, body: (await res.json()) as TokenResponse & Partial<TokenError> };
}
