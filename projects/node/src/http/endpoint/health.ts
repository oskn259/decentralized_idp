import { HealthResponseWire, healthResponse } from "@decentralized-idp/sdk/node-api";
import { z } from "zod";
import { IdentityNode } from "../../domain/usecase/identity-node.js";

/** `GET /health` */
export function health(node: IdentityNode): HealthResponseWire {
  const { nodeId, groupPublicKey, publicUrl } = node.identity;
  return z.encode(healthResponse, { status: "ok", nodeId, groupPublicKey, publicUrl });
}
