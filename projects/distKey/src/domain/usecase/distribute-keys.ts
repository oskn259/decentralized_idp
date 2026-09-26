import { DPoPKeyPair, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { publicKeyOf } from "@decentralized-idp/sdk/frost";
import { randomScalar } from "@decentralized-idp/sdk/scalar";
import { splitSecret } from "@decentralized-idp/sdk/shamir";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** An EVM account for x402: the payee's `payTo` and gas payer, or the payer's signer. */
export interface Wallet {
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

export interface NodeKeys {
  nodeId: number;
  /** s_i */
  secretKeyShare: bigint;
  wallet: Wallet;
}

/** A party that authenticates with `private_key_jwt`: an ordinary Ed25519 pair (the same shape as a DPoP key) and a wallet. */
export interface ClientKeys {
  clientId: string;
  keyPair: DPoPKeyPair;
  wallet: Wallet;
}

export interface DistributedKeys {
  threshold: number;
  total: number;
  /** Y = s·B, the key every token is verified against. */
  groupPublicKey: Uint8Array;
  nodes: NodeKeys[];
  /** The relying parties. */
  clients: ClientKeys[];
  /** The gateway, as the nodes' client. */
  gateway: ClientKeys;
}

/**
 * The trusted dealer's job: one group signing key split t-of-n (node i gets s_i, everyone
 * gets Y), and, for the demo, the identities money and authentication need: a key pair and a
 * wallet for each relying party, for the gateway, and a wallet for each node. The dealer is
 * the only party that sees the whole group key and every share. Users register themselves
 * later, from the browser.
 */
export function distributeKeys(threshold: number, total: number, clientIds: string[]): DistributedKeys {
  const groupSecret = randomScalar();
  const nodes = splitSecret(groupSecret, threshold, total).map((share) => ({ nodeId: share.id, secretKeyShare: share.value, wallet: newWallet() }));
  const client = (clientId: string): ClientKeys => ({ clientId, keyPair: generateDPoPKeyPair(), wallet: newWallet() });
  return { threshold, total, groupPublicKey: publicKeyOf(groupSecret), nodes, clients: clientIds.map(client), gateway: client("gateway") };
}

function newWallet(): Wallet {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}
