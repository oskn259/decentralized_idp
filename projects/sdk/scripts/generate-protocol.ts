// Writes the schemas and vectors into `../protocol`. Run after changing what they derive from, then review the diff.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateProtocolFiles } from "./protocol.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../protocol");

for (const [relative, content] of Object.entries(generateProtocolFiles())) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(content, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
