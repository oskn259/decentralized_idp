import fs from "node:fs";
import { Clock } from "../domain/infra/clock.js";
import { RoundStore } from "../domain/infra/round-store.js";
import { Billing, IdentityNode } from "../domain/usecase/identity-node.js";
import { DEFAULT_KEY_ID } from "../domain/value/node-identity.js";
import { FileCreditStore } from "./credit-store.js";
import { loadGateways } from "./gateways.js";
import { FileUserRepository } from "./user-store.js";
import { FrostNonces } from "@decentralized-idp/sdk/frost";
import { hexToBigInt, hexToBytes } from "@decentralized-idp/sdk/hex";
import { USDC, evmSettler } from "@decentralized-idp/sdk/x402";

// ---- the dealer's file ------------------------------------------------------

/** `node-<id>.json`, version 3. Byte strings and scalars are lowercase hex; scalars are 64 digits, big-endian. */
interface NodeConfigFile {
  nodeId: number;
  threshold: number;
  total: number;
  groupPublicKey: string;
  secretKeyShare: string;
  wallet?: { address?: string; privateKey?: string };
}

/** The EVM account that receives payments for `/sign` and pays the gas of settling them. */
export interface Wallet {
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

export interface NodeConfig {
  nodeId: number;
  threshold: number;
  total: number;
  groupPublicKey: Uint8Array;
  secretKeyShare: bigint;
  wallet: Wallet;
}

export function loadNodeConfig(path: string): NodeConfig {
  return parseNodeConfig(fs.readFileSync(path, "utf8"));
}

export function parseNodeConfig(text: string): NodeConfig {
  const file = JSON.parse(text) as NodeConfigFile;
  return {
    nodeId: file.nodeId,
    threshold: file.threshold,
    total: file.total,
    groupPublicKey: hexToBytes(file.groupPublicKey),
    secretKeyShare: hexToBigInt(file.secretKeyShare),
    wallet: walletOf(file.wallet),
  };
}

function walletOf(wallet: NodeConfigFile["wallet"]): Wallet {
  const { address, privateKey } = wallet ?? {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "") || !/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? "")) {
    throw new Error("node config: wallet must be { address: 0x + 40 hex, privateKey: 0x + 64 hex }");
  }
  return { address: address as `0x${string}`, privateKey: privateKey as `0x${string}` };
}

// ---- in-process implementations of the domain interfaces --------------------

export class InMemoryRoundStore implements RoundStore {
  private readonly nonces = new Map<string, FrostNonces>();

  open(roundId: string, nonces: FrostNonces): void {
    this.nonces.set(roundId, nonces);
  }

  take(roundId: string): FrostNonces | undefined {
    const nonces = this.nonces.get(roundId);
    this.nonces.delete(roundId);
    return nonces;
  }
}

export const systemClock: Clock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
};

// ---- assembly ----------------------------------------------------------------

export interface NodeOptions {
  issuer: string;
  publicUrl: string;
  /** The users registered so far; created on the first registration. */
  usersFile: string;
  billing: BillingOptions;
}

export interface BillingOptions {
  /** The gateways allowed to call `/sign`, in the shape of the gateway's `clients.json`. */
  gatewaysFile: string;
  /** The credit left per gateway; created on the first payment. */
  creditsFile: string;
  network: keyof typeof USDC;
  rpcUrl: string;
  /** Price of one `/sign`, in atomic USDC units (10⁻⁶). */
  unitAmount: bigint;
  /** `/sign` requests bought per payment. */
  batch: number;
}

/** Payments go to the node's wallet, and the node settles them itself with the same wallet. */
function billingOf(wallet: Wallet, options: BillingOptions): Billing {
  return {
    gateways: loadGateways(options.gatewaysFile),
    terms: { ...USDC[options.network], payTo: wallet.address, unitAmount: options.unitAmount, batch: options.batch },
    credits: new FileCreditStore(options.creditsFile),
    settler: evmSettler(options.network, options.rpcUrl, wallet.privateKey),
  };
}

export function nodeFromConfig(config: NodeConfig, { issuer, publicUrl, usersFile, billing }: NodeOptions): IdentityNode {
  return {
    identity: {
      nodeId: config.nodeId,
      secretKeyShare: config.secretKeyShare,
      groupPublicKey: config.groupPublicKey,
      issuer,
      publicUrl,
      keyId: DEFAULT_KEY_ID,
    },
    users: new FileUserRepository(usersFile),
    rounds: new InMemoryRoundStore(),
    clock: systemClock,
    billing: billingOf(config.wallet, billing),
  };
}
