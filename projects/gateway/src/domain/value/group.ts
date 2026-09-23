/** The group as the gateway knows it: public key material only, never a share. */
export interface Group {
  /** The gateway's URL as the browser sees it, no trailing slash: `iss` of every token. */
  issuer: string;
  /** How many nodes must sign for a signature to aggregate. */
  threshold: number;
  /** Y, published in the JWKS. */
  groupPublicKey: Uint8Array;
  /** `kid` of that key. */
  keyId: string;
}

export function tokenEndpointUrl(group: Group): string {
  return `${group.issuer}/token`;
}
