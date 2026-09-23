import { distributeKeys, UserSpec } from "../src/domain/usecase/distribute-keys.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existingOutputFiles, KEY_ID, outputFileNames, outputFiles, writeOutputFiles } from "../src/infra/output.js";

const USERS: UserSpec[] = [
  { username: "alice", password: "correct horse battery staple", sub: "usr_alice" },
  { username: "bob", password: "hunter2000", sub: "usr_bob" },
];

const HEX64 = /^[0-9a-f]{64}$/;

describe("outputFiles", () => {
  it("produces group.json and node-<id>.json for every node", () => {
    const keys = distributeKeys(2, 3, USERS);
    const files = outputFiles(keys);
    expect(files.map((f) => f.name)).toEqual(["group.json", "node-1.json", "node-2.json", "node-3.json"]);
  });

  it("group.json has the documented fields", () => {
    const keys = distributeKeys(2, 3, USERS);
    const [group] = outputFiles(keys);
    const parsed = JSON.parse(group.content);
    expect(parsed).toEqual({
      version: 1,
      threshold: 2,
      total: 3,
      keyId: KEY_ID,
      groupPublicKey: expect.stringMatching(HEX64),
    });
  });

  it("node-<id>.json has the documented fields, hex-encoded", () => {
    const keys = distributeKeys(2, 3, USERS);
    const files = outputFiles(keys);
    const node1 = JSON.parse(files.find((f) => f.name === "node-1.json")!.content);

    expect(node1.version).toBe(1);
    expect(node1.nodeId).toBe(1);
    expect(node1.threshold).toBe(2);
    expect(node1.total).toBe(3);
    expect(node1.groupPublicKey).toMatch(HEX64);
    expect(node1.secretKeyShare).toMatch(HEX64);
    expect(node1.users).toHaveLength(2);
    for (const user of node1.users) {
      expect(typeof user.username).toBe("string");
      expect(typeof user.sub).toBe("string");
      expect(user.toprfKeyShare.id).toBe(1);
      expect(user.toprfKeyShare.value).toMatch(HEX64);
      expect(user.h_i).toMatch(HEX64);
    }
  });

  it("group.json and every node file share the same groupPublicKey", () => {
    const keys = distributeKeys(2, 3, USERS);
    const files = outputFiles(keys);
    const publicKeys = files.map((f) => JSON.parse(f.content).groupPublicKey);
    expect(new Set(publicKeys).size).toBe(1);
  });

  it("no password appears anywhere in any file's content", () => {
    const keys = distributeKeys(2, 3, USERS);
    const written = outputFiles(keys).map((f) => f.content).join();
    for (const user of USERS) {
      expect(written).not.toContain(user.password);
    }
  });

  it("every file's content is 2-space indented JSON with a trailing newline", () => {
    const keys = distributeKeys(2, 3, USERS);
    const files = outputFiles(keys);
    for (const file of files) {
      expect(file.content.endsWith("\n")).toBe(true);
      expect(file.content.endsWith("\n\n")).toBe(false);
      const reindented = JSON.stringify(JSON.parse(file.content), null, 2) + "\n";
      expect(file.content).toBe(reindented);
    }
  });
});

describe("outputFileNames", () => {
  it("lists group.json plus one node file per id 1..total", () => {
    expect(outputFileNames(3)).toEqual(["group.json", "node-1.json", "node-2.json", "node-3.json"]);
    expect(outputFileNames(1)).toEqual(["group.json", "node-1.json"]);
    expect(outputFileNames(0)).toEqual(["group.json"]);
  });
});

describe("existingOutputFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "distkey-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'none' when the directory holds none of the expected files", () => {
    expect(existingOutputFiles(dir, outputFileNames(3))).toBe("none");
  });

  it("returns 'some' when only part of the expected files are present", () => {
    fs.writeFileSync(path.join(dir, "group.json"), "{}");
    expect(existingOutputFiles(dir, outputFileNames(3))).toBe("some");
  });

  it("returns 'all' when every expected file is present", () => {
    for (const name of outputFileNames(3)) {
      fs.writeFileSync(path.join(dir, name), "{}");
    }
    expect(existingOutputFiles(dir, outputFileNames(3))).toBe("all");
  });
});

describe("writeOutputFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "distkey-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the directory (recursively) and writes every file's content verbatim", () => {
    const keys = distributeKeys(2, 3, USERS);
    const files = outputFiles(keys);
    const nested = path.join(dir, "a", "b");
    writeOutputFiles(nested, files);
    for (const file of files) {
      expect(fs.readFileSync(path.join(nested, file.name), "utf8")).toBe(file.content);
    }
  });
});
