import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDPoPProof, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { verifyJwt } from "@decentralized-idp/sdk/jwt";
import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { Gateway } from "../src/domain/usecase/gateway.js";
import { createDemoLog } from "../src/http/demo-log.js";
import { createGatewayServer } from "../src/http/server.js";
import { loadGroup } from "../src/infra/group.js";
import { HttpNode } from "../src/infra/node.js";
import { openBrowser, signOn, token } from "./helpers/browser.js";
import { TestClock } from "./helpers/clock.js";
import { LiveNode, nodeFixturePath, startLiveNodes, stopLiveNodes } from "./helpers/live-node.js";
import { TempDist, makeTempDist } from "./helpers/temp-dist.js";

/**
 * Three real identity nodes (`../node`, in process) behind the real gateway, all over HTTP.
 * The nodes start before the gateway's port is known, so both sides take `ISSUER` as a
 * fixed string: it is the `iss`, `aud` and DPoP `htu` they check against each other.
 */

const ISSUER = "http://localhost:3000";
const RP_ORIGIN = "http://localhost:5173";
const CLIENT_ID = "demo_client";
const SCOPE = "openid profile";

let liveNodes: LiveNode[];
let clock: TestClock;
let dist: TempDist;
let gatewayServer: http.Server;
let gatewayUrl: string;
let gateway: Gateway;
let logLines: string[];

beforeAll(async () => {
  clock = new TestClock(1_700_000_000);
  liveNodes = await startLiveNodes({ issuer: ISSUER, clock });
  dist = makeTempDist();

  const group = loadGroup(nodeFixturePath("group.json"), ISSUER);
  gateway = {
    group,
    nodes: liveNodes.map((n) => new HttpNode(n.nodeId, n.url)),
    clock,
  };
  logLines = [];
  const demo = createDemoLog({ env: { DEMO_LOG: "1" }, isTty: false, write: (l) => logLines.push(l) });
  gatewayServer = createGatewayServer(gateway, demo, { loginDist: dist.dir, rpOrigin: RP_ORIGIN });
  await new Promise<void>((resolve, reject) => {
    gatewayServer.once("error", reject);
    gatewayServer.listen(0, "127.0.0.1", () => {
      gatewayServer.removeListener("error", reject);
      resolve();
    });
  });
  const address = gatewayServer.address() as AddressInfo;
  gatewayUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    gatewayServer.closeAllConnections();
    gatewayServer.close(() => resolve());
  });
  await stopLiveNodes(liveNodes);
  dist.cleanup();
});

function freshBrowser() {
  return openBrowser(gatewayUrl, ISSUER, CLIENT_ID, SCOPE);
}

describe("sign-on: the browser's assertion", () => {
  it("signs alice in and gets back a verifiable assertion", async () => {
    logLines.length = 0;
    const browser = freshBrowser();
    const assertion = await signOn(browser, "alice", "password123", `c-${crypto.randomUUID()}`, clock.nowSeconds());

    const { header, payload } = verifyJwt(assertion, gateway.group.groupPublicKey);
    expect(header.typ).toBe("JWT");
    expect(payload.sub).toBe("usr_alice_12345");
    expect(payload.aud).toBe(ISSUER);
    expect(payload.cnf).toEqual({ jkt: browser.jkt });
  });

  it("logs sign-on as two lines marked (no pw), and never the password", async () => {
    logLines.length = 0;
    const browser = freshBrowser();
    await signOn(browser, "alice", "password123", `c-${crypto.randomUUID()}`, clock.nowSeconds());

    // A continuation line is indented to the demo log's text column (20 characters).
    const signOnLines = logLines.filter((l) => l.includes("sign-on") || l.startsWith(" ".repeat(20)));
    expect(signOnLines.length).toBeGreaterThanOrEqual(2);
    expect(signOnLines[0]).toContain("(no pw)");
    for (const line of logLines) {
      expect(line).not.toContain("password123");
    }
  });

  it("fails with the wrong password (share decryption fails)", async () => {
    const browser = freshBrowser();
    await expect(signOn(browser, "alice", "WRONG-password", `c-${crypto.randomUUID()}`, clock.nowSeconds())).rejects.toThrow();
  });
});

describe("token: authorization_code and refresh_token", () => {
  it("mints an access token and refresh token bound to the browser's DPoP key", async () => {
    const browser = freshBrowser();
    const assertion = await signOn(browser, "alice", "password123", `c-${crypto.randomUUID()}`, clock.nowSeconds());

    const res = await token(browser, "authorization_code", assertion, { now: clock.nowSeconds() });
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe("DPoP");
    expect(res.body.expires_in).toBe(3600);
    expect(res.body.scope).toBe(SCOPE);

    const at = verifyJwt(res.body.access_token, gateway.group.groupPublicKey);
    expect(at.header.typ).toBe("at+jwt");
    expect(at.payload.aud).toBe(CLIENT_ID);
    expect(at.payload.cnf).toEqual({ jkt: browser.jkt });
    expect((at.payload.exp as number) - (at.payload.iat as number)).toBe(3600);

    const rt = verifyJwt(res.body.refresh_token, gateway.group.groupPublicKey);
    expect(rt.header.typ).toBe("refresh+jwt");
    expect(rt.payload.cnf).toEqual({ jkt: browser.jkt });
  });

  it("refreshes with a fresh DPoP proof, rotating both tokens", async () => {
    const browser = freshBrowser();
    const assertion = await signOn(browser, "alice", "password123", `c-${crypto.randomUUID()}`, clock.nowSeconds());
    const first = await token(browser, "authorization_code", assertion, { now: clock.nowSeconds() });
    expect(first.status).toBe(200);

    const second = await token(browser, "refresh_token", first.body.refresh_token, { now: clock.nowSeconds() });
    expect(second.status).toBe(200);
    expect(second.body.access_token).not.toBe(first.body.access_token);
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);

    expect(() => verifyJwt(second.body.access_token, gateway.group.groupPublicKey)).not.toThrow();
    expect(() => verifyJwt(second.body.refresh_token, gateway.group.groupPublicKey)).not.toThrow();
  });

  it("refuses a DPoP proof bound to a foreign key with invalid_dpop_proof", async () => {
    const browser = freshBrowser();
    const assertion = await signOn(browser, "alice", "password123", `c-${crypto.randomUUID()}`, clock.nowSeconds());

    const foreignKeyPair = generateDPoPKeyPair();
    const foreignProof = createDPoPProof(foreignKeyPair, "POST", `${ISSUER}/token`, clock.nowSeconds());
    const res = await token(browser, "authorization_code", assertion, { proof: foreignProof });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_dpop_proof");
  });

  it("refuses a tampered assertion with invalid_grant", async () => {
    const browser = freshBrowser();
    const assertion = await signOn(browser, "alice", "password123", `c-${crypto.randomUUID()}`, clock.nowSeconds());

    const [h, p, sig] = assertion.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.sub = "usr_bob_67890";
    const forged = `${h}.${base64UrlEncode(JSON.stringify(payload))}.${sig}`;

    const res = await token(browser, "authorization_code", forged, { now: clock.nowSeconds() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });
});

describe("degraded quorum", () => {
  it("still signs on and issues tokens with 2 of 3, excluding the down node in the demo log", async () => {
    await liveNodes.find((n) => n.nodeId === 3)!.close();

    logLines.length = 0;
    const browser = freshBrowser();
    const assertion = await signOn(browser, "alice", "password123", `c-${crypto.randomUUID()}`, clock.nowSeconds());
    expect(assertion.split(".")).toHaveLength(3);

    const res = await token(browser, "authorization_code", assertion, { now: clock.nowSeconds() });
    expect(res.status).toBe(200);

    expect(logLines.some((l) => l.includes("(node3 unreachable, excluded)"))).toBe(true);
  });

  it("fails quorum once a second node is down, with the documented message", async () => {
    await liveNodes.find((n) => n.nodeId === 2)!.close();

    const browser = freshBrowser();
    await expect(
      signOn(browser, "alice", "password123", `c-${crypto.randomUUID()}`, clock.nowSeconds())
    ).rejects.toThrow(/quorum 1 < 2/);

    // The browser helper's error carries only the status; the reason is read off the endpoint itself.
    const rawRes = await fetch(`${gatewayUrl}/api/pasta/sign-on`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        blinded: base64UrlEncode(new Uint8Array(32).fill(1)),
        sessionNonce: base64UrlEncode(new Uint8Array(16).fill(2)),
        cnfJkt: "jkt",
        clientId: CLIENT_ID,
        scope: SCOPE,
        nonce: "n",
        iat: clock.nowSeconds(),
        exp: clock.nowSeconds() + 30,
      }),
    });
    expect(rawRes.status).toBe(400);
    const body = await rawRes.json();
    expect(body.error).toContain("quorum 1 < 2");
  });
});
