import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signOn } from "../../idpFront/src/client/sign-on.js";
import { createRpServer } from "../src/http/server.js";
import { LiveGateway, startLiveGateway } from "./helpers/live-gateway.js";
import { LiveNode, startLiveNodes, stopLiveNodes } from "./helpers/live-node.js";

/**
 * The whole sign-in as the browser drives it: `/login` → the gateway's `/authorize` → the
 * login page's `signOn` (`../idpFront/src/client`) → `/callback`, over three real nodes and
 * a real gateway. The relying party and `openid-client` stamp wall-clock DPoP proofs and
 * discovery caching, so the stack runs on the real clock, and the gateway listens where its
 * issuer says it does.
 */

const CLIENT_ID = "demo_client";
const SCOPE = "profile";
// Never dereferenced: the test drives `/callback` and `/refresh` itself against the real
// listening address, so any redirect_uri base is fine as long as it is used consistently.
const RP_URL = "http://rp.test";

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
  liveGateway = await startLiveGateway({ issuer, clock, rpOrigin: RP_URL, nodes: liveNodes, port });
  rpServer = await createRpServer({ gatewayUrl: issuer, rpUrl: RP_URL, clientId: CLIENT_ID, scope: SCOPE });
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

/** `GET rp/login`: the 302 to the gateway's `/authorize`, with every field the RP promises. */
async function startLogin(): Promise<URL> {
  const fromRp = await fetch(`${rpUrl}/login`, { redirect: "manual" });
  expect(fromRp.status).toBe(302);
  const authorizeUrl = new URL(fromRp.headers.get("location") as string);
  expect(authorizeUrl.origin).toBe(liveGateway.url);
  expect(authorizeUrl.pathname).toBe("/authorize");
  expect(authorizeUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${RP_URL}/callback`);
  expect(authorizeUrl.searchParams.get("scope")).toBe(SCOPE);
  expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
  expect(authorizeUrl.searchParams.get("dpop_jkt")).toBeTruthy();
  return authorizeUrl;
}

/** `GET gateway/authorize`: the 302 to the login page, carrying the challenge `c`. */
async function followAuthorize(authorizeUrl: URL): Promise<{ state: string; dpopJkt: string; challenge: string }> {
  const fromGateway = await fetch(authorizeUrl, { redirect: "manual" });
  expect(fromGateway.status).toBe(302);
  const loginPage = new URL(fromGateway.headers.get("location") as string, liveGateway.url);
  expect(loginPage.pathname).toBe("/login");
  expect(loginPage.searchParams.get("redirect_uri")).toBe(`${RP_URL}/callback`);
  return {
    state: loginPage.searchParams.get("state") as string,
    dpopJkt: loginPage.searchParams.get("dpop_jkt") as string,
    challenge: loginPage.searchParams.get("c") as string,
  };
}

/** `/login` → `/authorize` → the login page's challenge, as one alice sign-on's assertion. */
async function signOnAsAlice(): Promise<{ state: string; assertion: string }> {
  const authorizeUrl = await startLogin();
  const { state, dpopJkt, challenge } = await followAuthorize(authorizeUrl);
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
  return { state, assertion };
}

/** A gateway redirect back to the RP's (fake) origin, replayed against the RP's real address. */
function toRp(location: string): string {
  const target = new URL(location, RP_URL);
  const real = new URL(rpUrl);
  target.protocol = real.protocol;
  target.host = real.host;
  return target.toString();
}

/**
 * Flips one character of the JWT's signature segment, so it no longer verifies. The change
 * lands mid-string, not on the last base64url group: flipping *there* can fall on the padding
 * bits a non-multiple-of-3 byte length discards, leaving the decoded bytes (and so the
 * signature) unchanged.
 */
function tamperSignature(jwt: string): string {
  const parts = jwt.split(".");
  const sig = parts[2];
  const i = Math.floor(sig.length / 2);
  const flipped = sig[i] === "A" ? "B" : "A";
  parts[2] = sig.slice(0, i) + flipped + sig.slice(i + 1);
  return parts.join(".");
}

describe("the sign-in, end to end", () => {
  it("shows alice's claims after /callback, and again after Refresh", async () => {
    const { state, assertion } = await signOnAsAlice();

    const callback = await fetch(`${rpUrl}/callback?${new URLSearchParams({ code: assertion, state })}`);
    expect(callback.status).toBe(200);
    const page = await callback.text();
    expect(page).toContain("usr_alice_12345");
    expect(page).toContain(SCOPE);
    const session = /name="session" value="([^"]+)"/.exec(page)?.[1] as string;
    expect(session).toBeTruthy();

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
    expect(await replay.text()).toBe("unknown state");
  });

  it("refuses /refresh with a session nobody holds", async () => {
    const res = await fetch(`${rpUrl}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ session: "nobody" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unknown session");
  });

  it("shows the gateway's OAuth error with its status when the assertion's signature is tampered", async () => {
    const { state, assertion } = await signOnAsAlice();
    const tampered = tamperSignature(assertion);

    const res = await fetch(`${rpUrl}/callback?${new URLSearchParams({ code: tampered, state })}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_grant");
  });

  it("shows the gateway's /authorize refusal, redirected all the way back through the RP", async () => {
    const authorizeUrl = await startLogin();
    const state = authorizeUrl.searchParams.get("state") as string;
    authorizeUrl.searchParams.delete("scope");

    const refused = await fetch(authorizeUrl, { redirect: "manual" });
    expect(refused.status).toBe(302);
    const back = new URL(refused.headers.get("location") as string, RP_URL);
    expect(back.origin + back.pathname).toBe(`${RP_URL}/callback`);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe(state);

    const atRp = await fetch(toRp(back.toString()));
    expect(atRp.status).toBe(400);
    expect(await atRp.text()).toContain("invalid_request");
  });
});
