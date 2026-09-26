import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { bigIntToHex } from "@decentralized-idp/sdk/hex";
import { UserShare, createUserShares } from "@decentralized-idp/sdk/register";

export interface RegisterRequest {
  /** Base URL of the gateway; `""` when the page is served by the gateway itself. */
  gatewayUrl: string;
  username: string;
  password: string;
  /** Receives the browser column of the demo trace, one line at a time. */
  log?: (line: string) => void;
}

/** `GET /api/pasta/nodes`: where to reach each node for registration. */
interface NodesResponse {
  threshold: number;
  total: number;
  nodes: RegistrationNode[];
}

interface RegistrationNode {
  nodeId: number;
  /** Where the browser reaches this node. */
  url: string;
}

/**
 * The browser's half of registration: chooses `sub`, draws the user's TOPRF key `k`, splits
 * it into one share per node, and sends each node its own share directly over TLS. No sealing:
 * the browser talks to every node itself, and the gateway never sees a share, `k`, `h`, or `sub`.
 */
export async function register(request: RegisterRequest): Promise<string> {
  const log = request.log ?? (() => {});
  const { threshold, total, nodes } = await requestNodes(request);
  const shares = createUserShares(request.password, threshold, total);
  const sub = crypto.randomUUID();
  log(
    `[browser] register  user=${request.username} sub=${sub}  → k, k_i×${shares.length}, h, h_i×${shares.length}` +
      `  → /register on each node directly (not via the gateway)`
  );

  await Promise.all(nodes.map((node) => registerWithNode(node, request.username, sub, shares)));
  log(`[browser]           ← accepted ×${nodes.length}`);
  return sub;
}

/** `POST <node url>/register`. A node's error text becomes the thrown error; an unreachable node becomes its own. */
async function registerWithNode(node: RegistrationNode, username: string, sub: string, shares: UserShare[]): Promise<void> {
  const share = shares.find((s) => s.nodeId === node.nodeId);
  if (!share) {
    throw new Error(`no share drawn for node ${node.nodeId}`);
  }
  const body = { username, sub, toprfKeyShare: bigIntToHex(share.toprfKeyShare.value), h_i: base64UrlEncode(share.h_i) };

  let res: Response;
  try {
    res = await fetch(`${node.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`node ${node.nodeId} unreachable`);
  }
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error: string };
    throw new Error(errorBody.error);
  }
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
