import fs from "node:fs";
import { CreditStore } from "@decentralized-idp/sdk/x402";

/**
 * The prepaid `/sign` requests left per gateway, as `{ "version": 1, "credits": { "<client_id>": <n> } }`.
 * A missing file means no credit yet. Held in memory, and the whole file rewritten on every
 * change: write `<path>.tmp`, then rename.
 */
export class FileCreditStore implements CreditStore {
  private readonly credits: Record<string, number>;

  constructor(private readonly path: string) {
    this.credits = fs.existsSync(path) ? (JSON.parse(fs.readFileSync(path, "utf8")) as { credits: Record<string, number> }).credits : {};
  }

  balance(payer: string): number {
    return this.credits[payer] ?? 0;
  }

  set(payer: string, balance: number): void {
    this.credits[payer] = balance;
    fs.writeFileSync(`${this.path}.tmp`, JSON.stringify({ version: 1, credits: this.credits }, null, 2));
    fs.renameSync(`${this.path}.tmp`, this.path);
  }
}
