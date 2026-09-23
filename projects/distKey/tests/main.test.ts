import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, parseUsers } from "../src/main.js";

function run(argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = main(argv, { write: (text: string) => (out += text) }, { write: (text: string) => (err += text) });
  return { code, out, err };
}

describe("main", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "distkey-main-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes group.json + node-1..3.json (default threshold/total) and exits 0", () => {
    const result = run(["--out", dir]);
    expect(result.code).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(["group.json", "node-1.json", "node-2.json", "node-3.json"]);
    expect(result.out).toContain("wrote 4 files");
  });

  it("a second run keeps the existing files unchanged and exits 0", () => {
    run(["--out", dir]);
    const before = fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), "utf8"));

    const second = run(["--out", dir]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("keeping");

    const after = fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), "utf8"));
    expect(after).toEqual(before);
  });

  it("a partial set of files exits 1 and leaves the remaining files untouched", () => {
    run(["--out", dir]);
    fs.unlinkSync(path.join(dir, "node-1.json"));
    const groupBefore = fs.readFileSync(path.join(dir, "group.json"), "utf8");
    const node2Before = fs.readFileSync(path.join(dir, "node-2.json"), "utf8");

    const result = run(["--out", dir]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("holds only part of a key set");
    expect(fs.existsSync(path.join(dir, "node-1.json"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "group.json"), "utf8")).toBe(groupBefore);
    expect(fs.readFileSync(path.join(dir, "node-2.json"), "utf8")).toBe(node2Before);
  });

  it("--force rewrites a partial set with a fresh set of keys", () => {
    run(["--out", dir]);
    const groupBefore = fs.readFileSync(path.join(dir, "group.json"), "utf8");
    fs.unlinkSync(path.join(dir, "node-1.json"));

    const result = run(["--out", dir, "--force"]);
    expect(result.code).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(["group.json", "node-1.json", "node-2.json", "node-3.json"]);
    expect(fs.readFileSync(path.join(dir, "group.json"), "utf8")).not.toBe(groupBefore);
  });

  it("--force rewrites a complete set with a fresh set of keys", () => {
    run(["--out", dir]);
    const groupBefore = fs.readFileSync(path.join(dir, "group.json"), "utf8");

    const result = run(["--out", dir, "--force"]);
    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, "group.json"), "utf8")).not.toBe(groupBefore);
  });

  it("--threshold 3 --total 5 writes 6 files", () => {
    const result = run(["--out", dir, "--threshold", "3", "--total", "5"]);
    expect(result.code).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(
      ["group.json", "node-1.json", "node-2.json", "node-3.json", "node-4.json", "node-5.json"].sort()
    );
    const group = JSON.parse(fs.readFileSync(path.join(dir, "group.json"), "utf8"));
    expect(group.threshold).toBe(3);
    expect(group.total).toBe(5);
  });

  it("--users with a password containing a colon round-trips through the node files, without the password", () => {
    const result = run(["--out", dir, "--users", "a:p:w:s1,b:q:s2"]);
    expect(result.code).toBe(0);
    const node1 = JSON.parse(fs.readFileSync(path.join(dir, "node-1.json"), "utf8"));
    expect(node1.users.map((u: { username: string; sub: string }) => [u.username, u.sub])).toEqual([
      ["a", "s1"],
      ["b", "s2"],
    ]);
    const written = fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), "utf8"));
    expect(written.join()).not.toContain("p:w");
  });

  it("a malformed --users entry exits 1 without writing files", () => {
    const result = run(["--out", dir, "--users", "not-valid"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("invalid --users entry");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("missing --out exits 1", () => {
    const result = run([]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--out <dir> is required");
  });

  it("--help exits 0 and prints usage without writing anything", () => {
    const result = run(["--help", "--out", dir]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage:");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("an unknown option exits 1", () => {
    const result = run(["--out", dir, "--bogus"]);
    expect(result.code).toBe(1);
  });
});

describe("parseUsers", () => {
  it("parses a single <username>:<password>:<sub> entry", () => {
    expect(parseUsers("alice:secret:usr_1")).toEqual([{ username: "alice", password: "secret", sub: "usr_1" }]);
  });

  it("parses multiple comma-separated entries", () => {
    expect(parseUsers("alice:pw1:s1,bob:pw2:s2")).toEqual([
      { username: "alice", password: "pw1", sub: "s1" },
      { username: "bob", password: "pw2", sub: "s2" },
    ]);
  });

  it("a password may itself contain colons: split on the first and last colon", () => {
    expect(parseUsers("alice:p:a:s:s:sword:usr_1")).toEqual([{ username: "alice", password: "p:a:s:s:sword", sub: "usr_1" }]);
  });

  it("throws when a field is missing", () => {
    expect(() => parseUsers("alice:secret")).toThrowError(/invalid --users entry/);
    expect(() => parseUsers("alice")).toThrowError(/invalid --users entry/);
    expect(() => parseUsers(":secret:sub")).toThrowError(/invalid --users entry/);
    expect(() => parseUsers("alice::sub")).toThrowError(/invalid --users entry/);
    expect(() => parseUsers("alice:secret:")).toThrowError(/invalid --users entry/);
  });
});
