/** A pre-registered relying party: who it is and the key its client assertions are signed with. */
export interface Client {
  clientId: string;
  /** Ed25519 public key, 32 bytes. */
  publicKey: Uint8Array;
}
