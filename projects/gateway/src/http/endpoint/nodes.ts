import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { Context } from "hono";
import { Gateway } from "../../domain/usecase/gateway.js";

/** `GET /api/pasta/nodes`: what the login page needs to seal one share per node. */
export function nodesEndpoint(gateway: Gateway, c: Context): Response {
  const nodes = [...gateway.nodes].sort((a, b) => a.nodeId - b.nodeId);
  return c.json({
    threshold: gateway.group.threshold,
    total: nodes.length,
    nodes: nodes.map((node) => ({ nodeId: node.nodeId, sealingPublicKey: base64UrlEncode(node.sealingPublicKey) })),
  });
}
