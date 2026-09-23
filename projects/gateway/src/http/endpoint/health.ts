import { Context } from "hono";
import { Gateway } from "../../domain/usecase/gateway.js";

/** How long one node may take to answer before `/health` reports it unhealthy. Shorter than Docker's probe timeout. */
const PROBE_TIMEOUT_MS = 2_000;

/** `GET /health`: 200 while a quorum of nodes answers, 503 `degraded` below it. */
export async function healthEndpoint(gateway: Gateway, c: Context): Promise<Response> {
  const nodes = await Promise.all(
    gateway.nodes.map(async (node) => ({
      nodeId: node.nodeId,
      url: node.url,
      healthy: await node.health(PROBE_TIMEOUT_MS).then(() => true, () => false),
    }))
  );
  const quorum = nodes.filter((n) => n.healthy).length >= gateway.group.threshold;
  return c.json({ status: quorum ? "ok" : "degraded", nodes }, quorum ? 200 : 503);
}
