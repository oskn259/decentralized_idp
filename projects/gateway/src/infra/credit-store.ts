import fs from "node:fs";
import { CreditStore } from "@decentralized-idp/sdk/x402";

/** `{ "version": 1, "credits": { "<payer>": n } }` */
interface CreditsFile {
  version: 1;
  credits: Record<string, number>;
}

/** Credits kept in memory and written whole to `path` on every change, so a restart keeps what was paid. */
export class FileCreditStore implements CreditStore {
  private readonly credits: Record<string, number>;

  constructor(private readonly path: string) {
    this.credits = fs.existsSync(path) ? (JSON.parse(fs.readFileSync(path, "utf8")) as CreditsFile).credits : {};
  }

  balance(payer: string): number {
    return this.credits[payer] ?? 0;
  }

  set(payer: string, balance: number): void {
    this.credits[payer] = balance;
    const file: CreditsFile = { version: 1, credits: this.credits };
    // Written beside and renamed over, so a crash never leaves half a file.
    fs.writeFileSync(`${this.path}.tmp`, JSON.stringify(file, null, 2));
    fs.renameSync(`${this.path}.tmp`, this.path);
  }
}
