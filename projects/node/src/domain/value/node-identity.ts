/** `kid` written into every JWT header; the gateway publishes the group key under it in its JWKS. */
export const DEFAULT_KEY_ID = "pasta-group-key-1";

/** What one node is, cryptographically: its FROST share, the group it belongs to, and its sealing key. */
export interface NodeIdentity {
  nodeId: number;
  /** s_i, this node's share of the group signing key. */
  secretKeyShare: bigint;
  /** Y, the Ed25519 public key every token is verified against. */
  groupPublicKey: Uint8Array;
  /** X25519 secret key that opens the shares a browser seals to this node at registration. */
  sealingSecretKey: Uint8Array;
  /** The gateway URL as the browser sees it, no trailing slash. Never taken from a request. */
  issuer: string;
  keyId: string;
}

/** The URL a DPoP proof must be bound to. */
export function tokenEndpoint(identity: NodeIdentity): string {
  return `${identity.issuer}/token`;
}
