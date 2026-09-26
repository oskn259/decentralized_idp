import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { eip3009ABI, toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

/**
 * Prepaid credit over x402 v2 (`exact` scheme, USDC). A paid endpoint admits a caller while
 * it has credit; with none, it answers 402 with `PAYMENT-REQUIRED`, and the caller retries
 * with `PAYMENT-SIGNATURE` paying for `batch` requests at once. The payee verifies and
 * settles the payment itself (it is its own facilitator), credits the caller, and answers
 * the request. Credit is charged only for a request that succeeded.
 */

export interface PaymentTerms {
  network: Network;
  /** The USDC contract, and its EIP-712 domain name and version. */
  asset: `0x${string}`;
  assetName: string;
  assetVersion: string;
  /** Where the money goes: the payee's wallet. */
  payTo: `0x${string}`;
  /** Price of one request, in the asset's atomic units (USDC: 10⁻⁶). */
  unitAmount: bigint;
  /** Requests bought per payment. */
  batch: number;
}

export const USDC: Record<"eip155:84532" | "eip155:8453", Pick<PaymentTerms, "network" | "asset" | "assetName" | "assetVersion">> = {
  "eip155:84532": { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", assetName: "USDC", assetVersion: "2" },
  "eip155:8453": { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", assetName: "USD Coin", assetVersion: "2" },
};

/** Remaining requests per caller. */
export interface CreditStore {
  balance(payer: string): number;
  set(payer: string, balance: number): void;
}

/** Verifies a payment and moves the money. `evmSettler` does it on chain; tests fake it. */
export interface Settler {
  settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

const CHAINS = { "eip155:84532": baseSepolia, "eip155:8453": base } as const;

/** The payee as its own x402 facilitator: `privateKey` pays the gas of `transferWithAuthorization`. */
export function evmSettler(network: keyof typeof CHAINS, rpcUrl: string, privateKey: `0x${string}`): Settler {
  const account = privateKeyToAccount(privateKey);
  // Public RPCs answer 429 under load; retry longer than viem's default before giving up.
  const wallet = createWalletClient({ account, chain: CHAINS[network], transport: http(rpcUrl, { retryCount: 6, retryDelay: 500 }) }).extend(publicActions);
  // viem's parameter types are stricter than the signer interface; the calls are the same.
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => wallet.readContract(args as Parameters<typeof wallet.readContract>[0]),
    verifyTypedData: (args) => wallet.verifyTypedData(args as Parameters<typeof wallet.verifyTypedData>[0]),
    writeContract: (args) => wallet.writeContract(args as Parameters<typeof wallet.writeContract>[0]),
    sendTransaction: (args) => wallet.sendTransaction(args),
    waitForTransactionReceipt: (args) => wallet.waitForTransactionReceipt(args),
    getCode: (args) => wallet.getCode(args),
  });
  const facilitator = new x402Facilitator().register(network, new ExactEvmScheme(signer));

  /** EIP-3009: an authorization the token contract has already consumed was paid, whatever the RPC said afterwards. */
  async function alreadyPaid(payment: PaymentPayload, requirements: PaymentRequirements): Promise<boolean> {
    const authorization = (payment.payload as { authorization?: { from?: `0x${string}`; nonce?: `0x${string}` } }).authorization;
    if (!authorization?.from || !authorization.nonce) return false;
    const used = await wallet.readContract({ address: requirements.asset as `0x${string}`, abi: eip3009ABI, functionName: "authorizationState", args: [authorization.from, authorization.nonce] }).catch(() => false);
    return used === true;
  }

  return {
    async settle(payment, requirements) {
      const verified = await facilitator.verify(payment, requirements);
      if (!verified.isValid) {
        return { success: false, errorReason: verified.invalidReason, errorMessage: verified.invalidMessage, transaction: "", network };
      }
      // A transaction can be mined while the RPC fails to report it; the payment must not be lost then.
      const settled = await facilitator.settle(payment, requirements).catch((err) => ({ success: false, errorMessage: String(err), transaction: "", network }) as SettleResponse);
      if (!settled.success && (await alreadyPaid(payment, requirements))) {
        return { success: true, transaction: "", network, payer: verified.payer };
      }
      return settled;
    },
  };
}

/** What a caller without credit is asked to pay: `batch` requests in one transfer. */
export function paymentRequired(terms: PaymentTerms, resourceUrl: string): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description: `${terms.batch} requests`, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: terms.network,
        asset: terms.asset,
        amount: (terms.unitAmount * BigInt(terms.batch)).toString(),
        payTo: terms.payTo,
        maxTimeoutSeconds: 300,
        extra: { name: terms.assetName, version: terms.assetVersion },
      },
    ],
  };
}

export type Admission =
  /** Serve the request. `paymentResponse` is the `PAYMENT-RESPONSE` header when a payment was just settled. */
  | { paid: true; paymentResponse?: string }
  /** Answer 402 with `paymentRequired` as the `PAYMENT-REQUIRED` header. */
  | { paid: false; paymentRequired: string; reason: string };

/**
 * Admits `payer` when it has credit. Otherwise, with a `PAYMENT-SIGNATURE` header, settles
 * the payment and credits `batch` requests; without one, asks for payment.
 */
export async function admit(
  store: CreditStore,
  settler: Settler,
  terms: PaymentTerms,
  payer: string,
  resourceUrl: string,
  paymentSignature: string | undefined
): Promise<Admission> {
  if (store.balance(payer) > 0) return { paid: true };

  const required = paymentRequired(terms, resourceUrl);
  const refuse = (reason: string): Admission => ({ paid: false, paymentRequired: encodePaymentRequiredHeader({ ...required, error: reason }), reason });
  if (paymentSignature === undefined) return refuse("payment required");

  let payment: PaymentPayload;
  try {
    payment = decodePaymentSignatureHeader(paymentSignature);
  } catch (err) {
    return refuse(`PAYMENT-SIGNATURE: ${err instanceof Error ? err.message : String(err)}`);
  }
  const requirements = required.accepts[0];
  if (payment.accepted.amount !== requirements.amount || payment.accepted.payTo !== requirements.payTo || payment.accepted.asset !== requirements.asset) {
    return refuse("payment does not match the requirements");
  }
  let settled: SettleResponse;
  try {
    settled = await settler.settle(payment, requirements);
  } catch (err) {
    return refuse(`settlement failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!settled.success) return refuse(`settlement failed: ${settled.errorReason ?? ""} ${settled.errorMessage ?? ""}`.trim());

  store.set(payer, store.balance(payer) + terms.batch);
  return { paid: true, paymentResponse: encodePaymentResponseHeader(settled) };
}

/** One request served: one credit gone. */
export function charge(store: CreditStore, payer: string): void {
  store.set(payer, store.balance(payer) - 1);
}
