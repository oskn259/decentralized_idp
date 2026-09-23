import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A throwaway `loginDist` directory: `index.html` plus one file under `assets/`. */
export interface TempDist {
  dir: string;
  cleanup(): void;
}

export function makeTempDist(): TempDist {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-login-dist-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>login</title>");
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log('app');");
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
