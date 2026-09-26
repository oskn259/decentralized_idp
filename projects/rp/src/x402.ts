import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import * as oauth from "openid-client";
import { privateKeyToAccount } from "viem/accounts";

/** A 402 from the token endpoint is paid automatically; the OAuth client does not know. */

export interface Wallet {
  privateKey: `0x${string}`;
  /** CAIP-2 chain id, e.g. eip155:84532. */
  network: `${string}:${string}`;
}

export function payWith(config: oauth.Configuration, wallet: Wallet): void {
  const payer = new x402Client().register(wallet.network, new ExactEvmScheme(privateKeyToAccount(wallet.privateKey)));
  config[oauth.customFetch] = wrapFetchWithPayment(fetch, payer) as oauth.CustomFetch;
}
