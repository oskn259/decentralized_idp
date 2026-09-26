import { base64UrlDecode, base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { UserShare, createUserShares, sealUserShare } from "@decentralized-idp/sdk/register";

export interface RegisterRequest {
  /** Base URL of the gateway; `""` when the page is served by the gateway itself. */
  gatewayUrl: string;
  username: string;
  password: string;
  /** Receives the browser column of the demo trace, one line at a time. */
  log?: (line: string) => void;
}

/** `GET /api/pasta/nodes`: the sealing keys registration needs, one per node. */
interface NodesResponse {
  threshold: number;
  total: number;
  nodes: SealingNode[];
}

interface SealingNode {
  nodeId: number;
  /** X25519 public key, base64url. */
  sealingPublicKey: string;
}

/** A sealed share on the wire, as `POST /api/pasta/register` expects it. */
interface SealedShareWire {
  nodeId: number;
  share: { ephemeralPublicKey: string; ciphertext: string };
}

/**
 * The browser's half of registration: draws the user's TOPRF key `k`, splits it into one
 * share per node, and seals each node's share so only that node can open it. The gateway
 * relays the sealed boxes and the username; it never sees a share, `k`, or `h`.
 */
export async function register(request: RegisterRequest): Promise<string> {
  const log = request.log ?? (() => {});
  const { threshold, total, nodes } = await requestNodes(request);
  const shares = createUserShares(request.password, threshold, total);
  log(
    `[browser] register  user=${request.username}  → k, k_i×${shares.length}, h, h_i×${shares.length} (sealed per node, gateway cannot open)`
  );

  const sealedShares = nodes.map((node) => sealShareFor(node, shares, request.username));
  const sub = await requestRegister(request, sealedShares, log);
  log(`[browser]           ← sub ${sub}`);
  return sub;
}

function sealShareFor(node: SealingNode, shares: UserShare[], username: string): SealedShareWire {
  const share = shares.find((s) => s.nodeId === node.nodeId);
  if (!share) {
    throw new Error(`no share drawn for node ${node.nodeId}`);
  }
  const box = sealUserShare(share, username, base64UrlDecode(node.sealingPublicKey));
  return { nodeId: node.nodeId, share: { ephemeralPublicKey: base64UrlEncode(box.ephemeralPublicKey), ciphertext: base64UrlEncode(box.ciphertext) } };
}

/** `GET /api/pasta/nodes`. The gateway's error text becomes the thrown error. */
async function requestNodes(request: RegisterRequest): Promise<NodesResponse> {
  const res = await fetch(`${request.gatewayUrl}/api/pasta/nodes`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error: string };
    throw new Error(body.error);
  }
  return (await res.json()) as NodesResponse;
}

/** `POST /api/pasta/register`. The gateway's error text becomes the thrown error. */
async function requestRegister(request: RegisterRequest, shares: SealedShareWire[], log: (line: string) => void): Promise<string> {
  const res = await fetch(`${request.gatewayUrl}/api/pasta/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: request.username, shares }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error: string };
    log(`[browser] ✖ register failed: ${body.error}`);
    throw new Error(body.error);
  }
  const { sub } = (await res.json()) as { sub: string };
  return sub;
}
