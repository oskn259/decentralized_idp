import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { loadNodeConfig, parseNodeConfig, systemClock } from "../src/infra/node.js";
import { fixturePath, readFixtureJson } from "./helpers/build-node.js";
import { bytesToHex } from "@decentralized-idp/sdk/hex";

/**
 * `infra/node.ts` maps the dealer's JSON to `NodeConfig`: hex fields through
 * `hexToBytes`/`hexToBigInt`, plus the one check the node depends on (a share dealt for
 * another node would evaluate the TOPRF silently wrong).
 */

const NODE_1 = readFixtureJson("node-1.json");
const GROUP = readFixtureJson("group.json");

function withNode1(mutate: (draft: any) => void): string {
  const draft = JSON.parse(JSON.stringify(NODE_1));
  mutate(draft);
  return JSON.stringify(draft);
}

describe("node config loading", () => {
  it("loads the dealer fixture for node 1", () => {
    const config = loadNodeConfig(fixturePath("node-1.json"));

    expect(config.nodeId).toBe(1);
    expect(config.threshold).toBe(2);
    expect(config.total).toBe(3);
    expect(bytesToHex(config.groupPublicKey)).toBe(GROUP.groupPublicKey);
    expect(config.groupPublicKey).toHaveLength(32);
    expect(config.users.map((u) => u.username)).toEqual(["alice", "bob"]);
    expect(config.users[0].sub).toBe("usr_alice_12345");
    expect(config.users[0].toprfKeyShare.id).toBe(1);
    expect(config.users[0].h_i).toHaveLength(32);
  });

  it("restores scalars big-endian", () => {
    const config = loadNodeConfig(fixturePath("node-1.json"));

    expect(config.secretKeyShare).toBe(BigInt("0x" + NODE_1.secretKeyShare));
    expect(config.users[0].toprfKeyShare.value).toBe(BigInt("0x" + NODE_1.users[0].toprfKeyShare.value));

    // A scalar whose hex ends in 01 is the number 1 when read big-endian, and a huge number
    // when read little-endian. This pins the byte order down.
    const oneBigEndian = withNode1((d) => {
      d.secretKeyShare = "00".repeat(31) + "01";
    });
    expect(parseNodeConfig(oneBigEndian).secretKeyShare).toBe(1n);
  });

  it("agrees on the group public key across all three node files", () => {
    const keys = ["node-1.json", "node-2.json", "node-3.json"].map((f) => bytesToHex(loadNodeConfig(fixturePath(f)).groupPublicKey));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(GROUP.groupPublicKey);
  });

  it.each([
    [1, "node-1.json"],
    [2, "node-2.json"],
    [3, "node-3.json"],
  ])("gives node %i the shares carrying its own id", (id, file) => {
    const config = loadNodeConfig(fixturePath(file));
    expect(config.nodeId).toBe(id);
    expect(config.users.map((user) => user.toprfKeyShare.id)).toEqual(config.users.map(() => id));
  });

  it("rejects a toprfKeyShare id that is not this node's id", () => {
    const text = withNode1((d) => {
      d.users[0].toprfKeyShare.id = 2;
    });
    expect(() => parseNodeConfig(text)).toThrowError(/user alice: toprfKeyShare\.id 2 is not this node's id 1/);
  });

  it("rejects non-hex text with the hex helper's error", () => {
    const nonHex = withNode1((d) => {
      d.secretKeyShare = "z".repeat(64);
    });
    expect(() => parseNodeConfig(nonHex)).toThrowError(/not a hex string/);

    const badHi = withNode1((d) => {
      d.users[1].h_i = "not hex either";
    });
    expect(() => parseNodeConfig(badHi)).toThrowError(/not a hex string/);
  });

  it("reports a missing file as the fs error", () => {
    const missing = fixturePath("node-99.json");
    expect(fs.existsSync(missing)).toBe(false);
    expect(() => loadNodeConfig(missing)).toThrowError(/ENOENT/);
  });
});

describe("systemClock", () => {
  it("reports the current time in whole seconds", () => {
    const before = Math.floor(Date.now() / 1000);
    const now = systemClock.nowSeconds();
    const after = Math.floor(Date.now() / 1000);
    expect(Number.isInteger(now)).toBe(true);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
