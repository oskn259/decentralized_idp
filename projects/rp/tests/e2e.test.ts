import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signOn } from "../../idpFront/src/client/sign-on.js";
import { LiveGateway, startLiveGateway } from "../../idpFront/tests/helpers/live-gateway.js";
import { LiveNode, startLiveNodes, stopLiveNodes } from "../../idpFront/tests/helpers/live-node.js";
import { createRpServer } from "../src/http/server.js";

/**
 * The whole sign-in as the browser drives it: `/login` → the gateway's `/authorize` → the
 * login page's `signOn` (`../idpFront/src/client`) → `/callback`, over three real nodes and
 * a real gateway. The relying party stamps wall-clock DPoP proofs, so the stack runs on the
 * real clock, and the gateway listens where its issuer says it does.
 */

const CLIENT_ID = "demo_client";
const SCOPE = "openid profile";

let liveNodes: LiveNode[];
let liveGateway: LiveGateway;
let rpServer: http.Server;
let rpUrl: string;

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

beforeAll(async () => {
  const clock = { nowSeconds: () => Math.floor(Date.now() / 1000) };
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  liveNodes = await startLiveNodes({ issuer, clock });
  liveGateway = await startLiveGateway({ issuer, clock, rpOrigin: "http://localhost:3001", nodes: liveNodes, port });
  // The gateway never calls back; the test drives /callback itself, so any redirect_uri base does.
  rpServer = createRpServer({ gatewayUrl: issuer, rpUrl: "http://rp.test", clientId: CLIENT_ID, scope: SCOPE });
  rpUrl = await listen(rpServer);
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    rpServer.closeAllConnections();
    rpServer.close(() => resolve());
  });
  await liveGateway.close();
  await stopLiveNodes(liveNodes);
});

/** `GET rp/login` → `GET gateway/authorize`, following the two redirects by hand as a browser would. */
async function openLoginPage(): Promise<{ state: string; dpopJkt: string; challenge: string }> {
  const fromRp = await fetch(`${rpUrl}/login`, { redirect: "manual" });
  expect(fromRp.status).toBe(302);
  const authorize = new URL(fromRp.headers.get("location") as string);
  expect(authorize.origin).toBe(liveGateway.url);

  const fromGateway = await fetch(authorize, { redirect: "manual" });
  expect(fromGateway.status).toBe(302);
  const loginPage = new URL(fromGateway.headers.get("location") as string, liveGateway.url);
  expect(loginPage.searchParams.get("redirect_uri")).toBe("http://rp.test/callback");
  return {
    state: authorize.searchParams.get("state") as string,
    dpopJkt: authorize.searchParams.get("dpop_jkt") as string,
    challenge: loginPage.searchParams.get("c") as string,
  };
}

describe("the sign-in, end to end", () => {
  it("shows alice's claims after /callback, and again after Refresh", async () => {
    const { state, dpopJkt, challenge } = await openLoginPage();
    const assertion = await signOn({
      gatewayUrl: liveGateway.url,
      issuer: liveGateway.url,
      username: "alice",
      password: "password123",
      clientId: CLIENT_ID,
      scope: SCOPE,
      cnfJkt: dpopJkt,
      nonce: challenge,
    });

    const callback = await fetch(`${rpUrl}/callback?${new URLSearchParams({ code: assertion, state })}`);
    expect(callback.status).toBe(200);
    const page = await callback.text();
    expect(page).toContain("usr_alice_12345");
    expect(page).toContain(SCOPE);
    const session = /name="session" value="([^"]+)"/.exec(page)?.[1] as string;

    const refreshed = await fetch(`${rpUrl}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ session }),
    });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.text()).toContain("usr_alice_12345");

    // The state was spent by the callback: the same code cannot come back a second time.
    const replay = await fetch(`${rpUrl}/callback?${new URLSearchParams({ code: assertion, state })}`);
    expect(replay.status).toBe(400);
  });

  it("shows the gateway's OAuth error with its status when the code is not an assertion", async () => {
    const { state } = await openLoginPage();
    const res = await fetch(`${rpUrl}/callback?${new URLSearchParams({ code: "not-a-jwt", state })}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_grant");
  });
});
