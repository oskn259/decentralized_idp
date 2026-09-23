import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every JSON file under schema/ and vectors/ parses, and every schema is JSON Schema draft 2020-12. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/** The .json files under `dir`, as paths relative to this package. */
function jsonFiles(dir) {
  return fs
    .readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

/** `{ content }` when the file parses, `{ error }` with the parser's message otherwise. */
function parseJson(file) {
  try {
    return { content: JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) };
  } catch (err) {
    return { error: err.message };
  }
}

/** What is wrong with one file, or undefined when nothing is. */
function problemOf(file) {
  const { content, error } = parseJson(file);
  if (error) return `${file}: ${error}`;
  if (file.startsWith("schema") && content.$schema !== DRAFT) return `${file}: $schema is not ${DRAFT}`;
  return undefined;
}

/** The problems in one directory. An empty directory is itself a problem. */
function problemsIn(dir) {
  const files = jsonFiles(dir);
  if (files.length === 0) return [`${dir}/ has no JSON files`];
  return files.map(problemOf).filter((problem) => problem !== undefined);
}

const problems = [...problemsIn("schema"), ...problemsIn("vectors")];
for (const problem of problems) {
  console.error(problem);
}
process.exit(problems.length === 0 ? 0 : 1);
