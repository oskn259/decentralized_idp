import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateJwkThumbprint, exportDPoPJwk, generateDPoPKeyPair } from "@decentralized-idp/sdk/dpop";
import { hexToBytes } from "@decentralized-idp/sdk/hex";
import { verifyJwt } from "@decentralized-idp/sdk/jwt";
import { signOn } from "../../idpFront/src/client/sign-on.js";
import { TestClock } from "../../idpFront/tests/helpers/clock.js";
import { LiveGateway, startLiveGateway } from "../../idpFront/tests/helpers/live-gateway.js";
import { LiveNode, nodeFixturePath, startLiveNodes, stopLiveNodes } from "../../idpFront/tests/helpers/live-node.js";
import { TokenError, TokenResponse, requestToken } from "../src/token.js";

/**
 * `requestToken` against three real identity nodes (`../node/src`) behind a real gateway
 * (`../gateway/src`), all real HTTP on `127.0.0.1:0`, driven by one hand-set clock. The
 * assertion it spends comes from the login page's `signOn`.
 */

const ISSUER = "http://localhost:3000";
const CLIENT_ID = "demo_client";
const SCOPE = "openid profile";

let liveNodes: LiveNode[];
let liveGateway: LiveGateway;
let clock: TestClock;
let groupPublicKey: Uint8Array;

beforeAll(async () => {
  clock = new TestClock(1_700_000_000);
  liveNodes = await startLiveNodes({ issuer: ISSUER, clock });
  liveGateway = await startLiveGateway({ issuer: ISSUER, clock, rpOrigin: "http://localhost:3001", nodes: liveNodes });
  const group = JSON.parse(fs.readFileSync(nodeFixturePath("group.json"), "utf8")) as { groupPublicKey: string };
  groupPublicKey = hexToBytes(group.groupPublicKey);
});

afterAll(async () => {
  await liveGateway.close();
  await stopLiveNodes(liveNodes);
});

function freshDpop() {
  const dpop = generateDPoPKeyPair();
  return { dpop, jkt: calculateJwkThumbprint(exportDPoPJwk(dpop.publicKey)) };
}

function signOnAs(username: string, password: string, cnfJkt: string) {
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
  });
}

describe("requestToken: the relying party's /token call", () => {
  it("mints an access token bound to the DPoP key via the assertion", async () => {
    const { dpop, jkt } = freshDpop();
    const assertion = await signOnAs("alice", "password123", jkt);

    const res = await requestToken({ gatewayUrl: liveGateway.url, issuer: ISSUER, dpop, grant: "authorization_code", credential: assertion, now: clock.nowSeconds() });
    expect(res.status).toBe(200);
    const body = res.body as TokenResponse;

    const at = verifyJwt(body.access_token, groupPublicKey);
    expect(at.header.typ).toBe("at+jwt");
    expect(at.payload.cnf).toEqual({ jkt });
  });

  it("refreshes with a fresh DPoP proof, rotating both tokens", async () => {
    const { dpop, jkt } = freshDpop();
    const assertion = await signOnAs("alice", "password123", jkt);

    const first = await requestToken({ gatewayUrl: liveGateway.url, issuer: ISSUER, dpop, grant: "authorization_code", credential: assertion, now: clock.nowSeconds() });
    expect(first.status).toBe(200);
    const firstBody = first.body as TokenResponse;

    const second = await requestToken({ gatewayUrl: liveGateway.url, issuer: ISSUER, dpop, grant: "refresh_token", credential: firstBody.refresh_token, now: clock.nowSeconds() });
    expect(second.status).toBe(200);
    const secondBody = second.body as TokenResponse;
    expect(secondBody.access_token).not.toBe(firstBody.access_token);
    expect(secondBody.refresh_token).not.toBe(firstBody.refresh_token);

    const at = verifyJwt(secondBody.access_token, groupPublicKey);
    expect(at.payload.cnf).toEqual({ jkt });
  });

  it("refuses a DPoP proof bound to a foreign key with invalid_dpop_proof", async () => {
    const { jkt } = freshDpop();
    const assertion = await signOnAs("alice", "password123", jkt);

    const foreignDpop = generateDPoPKeyPair();
    const res = await requestToken({ gatewayUrl: liveGateway.url, issuer: ISSUER, dpop: foreignDpop, grant: "authorization_code", credential: assertion, now: clock.nowSeconds() });

    expect(res.status).toBe(400);
    expect((res.body as TokenError).error).toBe("invalid_dpop_proof");
  });
});
