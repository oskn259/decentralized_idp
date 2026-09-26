import { Context } from "hono";
import { Gateway } from "../../domain/usecase/gateway.js";

/** `GET /api/pasta/nodes`: where the login page reaches each node to register a user. */
export function nodesEndpoint(gateway: Gateway, c: Context): Response {
  const nodes = [...gateway.nodes].sort((a, b) => a.nodeId - b.nodeId);
  return c.json({
    threshold: gateway.group.threshold,
    total: nodes.length,
    nodes: nodes.map((node) => ({ nodeId: node.nodeId, url: node.publicUrl })),
  });
}
