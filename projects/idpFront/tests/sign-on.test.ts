import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateJwkThumbprint, exportDPoPJwk, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { hexToBytes } from "@decentralized-idp/sdk/hex";
import { verifyJwt } from "@decentralized-idp/sdk/jwt";
import { ASSERTION_LIFETIME_SECONDS, KEY_ID, signOn } from "../src/client/sign-on.js";
import { TestClock } from "./helpers/clock.js";
import { LiveGateway, startLiveGateway } from "./helpers/live-gateway.js";
import { LiveNode, nodeFixturePath, startLiveNodes, stopLiveNodes } from "./helpers/live-node.js";

/**
 * `signOn` against three real identity nodes (`../node/src`) behind a real gateway
 * (`../gateway/src`), all real HTTP on `127.0.0.1:0`, driven by one hand-set clock.
 */

const ISSUER = "http://localhost:3000";
const RP_ORIGIN = "http://localhost:5173";
const CLIENT_ID = "demo_client";
const SCOPE = "openid profile";

let liveNodes: LiveNode[];
let liveGateway: LiveGateway;
let clock: TestClock;
let groupPublicKey: Uint8Array;

beforeAll(async () => {
  clock = new TestClock(1_700_000_000);
  liveNodes = await startLiveNodes({ issuer: ISSUER, clock });
  liveGateway = await startLiveGateway({ issuer: ISSUER, clock, rpOrigin: RP_ORIGIN, nodes: liveNodes });
  const group = JSON.parse(fs.readFileSync(nodeFixturePath("group.json"), "utf8")) as { groupPublicKey: string };
  groupPublicKey = hexToBytes(group.groupPublicKey);
});

afterAll(async () => {
  await liveGateway.close();
  await stopLiveNodes(liveNodes);
});

/** The relying party's DPoP thumbprint, as `/authorize` would carry it. Only the thumbprint reaches the page. */
function freshJkt(): string {
  return calculateJwkThumbprint(exportDPoPJwk(generateDPoPKeyPair().publicKey));
}

function signOnAs(username: string, password: string, cnfJkt: string, log?: (line: string) => void) {
  return signOn({
    gatewayUrl: liveGateway.url,
    issuer: ISSUER,
    username,
    password,
    clientId: CLIENT_ID,
    scope: SCOPE,
    cnfJkt,
    nonce: `n-${crypto.randomUUID()}`,
    now: clock.nowSeconds(),
    log,
  });
}

describe("signOn: the browser's assertion", () => {
  it("signs alice in and returns an assertion that verifies with the group key", async () => {
    const jkt = freshJkt();
    const assertion = await signOnAs("alice", "password123", jkt);

    const { header, payload } = verifyJwt(assertion, groupPublicKey);
    expect(header).toEqual({ alg: "EdDSA", typ: "JWT", kid: KEY_ID });
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(ISSUER);
    expect(payload.sub).toBe("usr_alice_12345");
    expect(payload.client_id).toBe(CLIENT_ID);
    expect(payload.scope).toBe(SCOPE);
    expect(payload.cnf).toEqual({ jkt });
    expect(typeof payload.nonce).toBe("string");
    expect((payload.exp as number) - (payload.iat as number)).toBe(ASSERTION_LIFETIME_SECONDS);
  });

  it("logs the three browser trace lines and never the password", async () => {
    const jkt = freshJkt();
    const lines: string[] = [];
    await signOnAs("alice", "password123", jkt, (line) => lines.push(line));

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[browser] sign-on");
    expect(lines[0]).toContain("user=alice");
    expect(lines[0]).toContain("nonce=");
    expect(lines[1]).toContain("[browser]");
    expect(lines[1]).toContain("← B_i×3");
    expect(lines[2]).toContain("[browser]");
    expect(lines[2]).toContain("→ h=finalize");
    expect(lines[2]).toContain("✔ assembled only here");
    expect(lines.join("\n")).not.toContain("password123");
  });

  it("fails with the wrong password: throws and logs a decrypt-failed line, never the password", async () => {
    const jkt = freshJkt();
    const lines: string[] = [];
    await expect(signOnAs("alice", "WRONG-password", jkt, (line) => lines.push(line))).rejects.toThrow(/wrong password/);

    expect(lines.some((l) => /✖ sign-on failed: ct_\d+ decrypt failed/.test(l))).toBe(true);
    expect(lines.join("\n")).not.toContain("password123");
    expect(lines.join("\n")).not.toContain("WRONG-password");
  });

  it("fails for an unknown user with the gateway's own error text", async () => {
    const jkt = freshJkt();
    const lines: string[] = [];
    await expect(signOnAs("carol", "whatever", jkt, (line) => lines.push(line))).rejects.toThrow(/User not found/);

    expect(lines.some((l) => l.startsWith("[browser] ✖ sign-on failed:"))).toBe(true);
  });
});
