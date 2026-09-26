import { decodeJwt, verifyJwt } from "@decentralized-idp/sdk/jwt";
import { tokenEndpointUrl } from "../value/group.js";
import { Gateway } from "./gateway.js";
import { OAuthError } from "./oauth-error.js";

/**
 * `private_key_jwt` (RFC 7523 §2.2, §3): the assertion must be signed by the registered key
 * of the client it names in `iss`, be addressed to this server, and not have expired.
 * `claimedClientId`, the form's `client_id` when sent, must name the same client.
 * Returns the client id. `jti` is not tracked for replay, as with DPoP proofs.
 */
export function authenticateClient(gateway: Gateway, clientAssertion: string, claimedClientId?: string): string {
  let clientId: string;
  try {
    clientId = verifiedClientId(gateway, clientAssertion);
  } catch (err) {
    throw new OAuthError("invalid_client", `client_assertion: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (claimedClientId !== undefined && claimedClientId !== clientId) {
    throw new OAuthError("invalid_client", `client_id ${claimedClientId} does not match the client assertion`);
  }
  return clientId;
}

function verifiedClientId(gateway: Gateway, clientAssertion: string): string {
  const iss = decodeJwt(clientAssertion).payload.iss;
  const client = gateway.clients.find((c) => c.clientId === iss);
  if (!client) throw new Error(`unknown client ${String(iss)}`);

  const { payload } = verifyJwt(clientAssertion, client.publicKey);
  if (payload.sub !== client.clientId) throw new Error("sub must equal iss");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const accepted = [gateway.group.issuer, tokenEndpointUrl(gateway.group)];
  if (!accepted.some((aud) => audiences.includes(aud))) throw new Error(`aud must be ${accepted.join(" or ")}`);
  if (typeof payload.exp !== "number" || payload.exp <= gateway.clock.nowSeconds()) throw new Error("expired");
  if (typeof payload.jti !== "string" || payload.jti === "") throw new Error("jti is missing");
  return client.clientId;
}
