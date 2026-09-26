import { decodeJwt, verifyJwt } from "@decentralized-idp/sdk/jwt";
import { IdentityNode } from "./identity-node.js";

/**
 * The gateway calling `/sign`, by its `private_key_jwt` (RFC 7523 §2.2, §3): the assertion
 * must be signed by the registered key of the gateway it names in `iss`, be addressed to
 * this node's `publicUrl`, and not have expired. Returns the gateway's client id, the one
 * that is charged. `jti` is not tracked for replay, as with DPoP proofs.
 */
export function authenticateCaller(node: IdentityNode, clientAssertion: string): string {
  try {
    return verifiedCallerId(node, clientAssertion);
  } catch (err) {
    throw new Error(`client_assertion: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function verifiedCallerId(node: IdentityNode, clientAssertion: string): string {
  const iss = decodeJwt(clientAssertion).payload.iss;
  const gateway = node.billing.gateways.find((g) => g.clientId === iss);
  if (!gateway) throw new Error(`unknown gateway ${String(iss)}`);

  const { payload } = verifyJwt(clientAssertion, gateway.publicKey);
  if (payload.sub !== gateway.clientId) throw new Error("sub must equal iss");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(node.identity.publicUrl)) throw new Error(`aud must be ${node.identity.publicUrl}`);
  if (typeof payload.exp !== "number" || payload.exp <= node.clock.nowSeconds()) throw new Error("expired");
  if (typeof payload.jti !== "string" || payload.jti === "") throw new Error("jti is missing");
  return gateway.clientId;
}
