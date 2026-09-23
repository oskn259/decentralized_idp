import { parseArgs } from "node:util";
import { DPoPKeyPair, calculateJwkThumbprint, exportDPoPJwk, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { signOn } from "./src/client/sign-on.js";
import { TokenResponse, requestToken } from "../rp/src/token.js";

/**
 * The browser, played from a terminal: both the relying party's front end (which owns the
 * DPoP key) and the login page (which turns the password into the assertion).
 *
 *   npx tsx cli.ts --gateway http://localhost:3000 --user alice --password password123 [--refresh]
 *
 * Prints the access token as the last line of stdout and nothing else there; the demo
 * trace goes to stderr.
 *
 * With `--jkt <thumbprint>` the DPoP key is somebody else's (a real relying party's), so
 * the CLI plays only the login page: it prints the assertion (the code) and stops.
 */

const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://localhost:3000" },
    issuer: { type: "string" },
    user: { type: "string", default: "alice" },
    password: { type: "string" },
    "client-id": { type: "string", default: "demo_client" },
    scope: { type: "string", default: "openid profile" },
    // The challenge `/authorize` would hand a browser. The CLI skips `/authorize` and makes its own.
    nonce: { type: "string", default: `cli-${crypto.randomUUID().slice(0, 8)}` },
    refresh: { type: "boolean", default: false },
    jkt: { type: "string" },
  },
});

const log = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<void> {
  if (!values.password) {
    process.stderr.write("--password is required\n");
    process.exit(1);
  }
  const gateway = values.gateway.replace(/\/+$/, "");
  const issuer = (values.issuer ?? gateway).replace(/\/+$/, "");

  // The relying party's part: make the DPoP key, publish only its thumbprint.
  const dpop = generateDPoPKeyPair();
  const jkt = values.jkt ?? calculateJwkThumbprint(exportDPoPJwk(dpop.publicKey));

  const assertion = await signOn({
    gatewayUrl: gateway,
    issuer,
    username: values.user,
    password: values.password,
    clientId: values["client-id"],
    scope: values.scope,
    cnfJkt: jkt,
    nonce: values.nonce,
    log,
  });

  if (values.jkt) {
    process.stdout.write(`${assertion}\n`);
    return;
  }

  let token = await exchange(gateway, issuer, dpop, "authorization_code", assertion);
  log(`[browser] token     grant=authz  → DPoP proof  ← access_token ${token.access_token.slice(0, 8)} (cnf.jkt bound)`);

  if (values.refresh) {
    token = await exchange(gateway, issuer, dpop, "refresh_token", token.refresh_token);
    log(`[browser] token     grant=refresh  → new DPoP proof  ← access_token ${token.access_token.slice(0, 8)} (rotated)`);
  }

  process.stdout.write(`${token.access_token}\n`);
}

/** `POST /token`; an OAuth error ends the run. */
async function exchange(
  gateway: string,
  issuer: string,
  dpop: DPoPKeyPair,
  grant: "authorization_code" | "refresh_token",
  credential: string
): Promise<TokenResponse> {
  const { status, body } = await requestToken({ gatewayUrl: gateway, issuer, dpop, grant, credential });
  if (!("access_token" in body)) {
    throw new Error(`/token ${status}: ${body.error}: ${body.error_description}`);
  }
  return body;
}

main().catch((err: unknown) => {
  process.stderr.write(`sign-on failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
