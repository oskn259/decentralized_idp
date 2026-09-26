import crypto from "node:crypto";
import { Browser, Page, chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GATEWAY_URL, RP_URL, SCOPE, logs, refusals, restore, stopNode, up } from "./helpers/compose.js";

/**
 * A person at the relying party's page, in Chromium, against the containers. One path is
 * driven: "Sign in" → the login page → "Sign on" → "Return to the relying party" → the claims
 * → "Refresh". The cases differ only in what is typed and which nodes are up, so the tests
 * that stop nodes come last and the stack is restored afterwards.
 */

let browser: Browser;
let page: Page;

/** A user this run creates; nothing is pre-registered. */
const USER = `user-${crypto.randomUUID().slice(0, 8)}`;
const PASSWORD = `pw-${crypto.randomUUID().slice(0, 8)}`;
/** The sub the gateway assigned at registration; read off the relying party's page. */
let sub: string;

beforeAll(async () => {
  up();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  console.log(refusals());
  restore();
});

beforeEach(async () => {
  page = await (await browser.newContext()).newPage();
});

afterEach(async () => {
  await page.context().close();
});

/** From the relying party's page to the login page's verdict on this username and password; `create` registers first. */
async function signOn(username: string, password: string, create = false): Promise<void> {
  await page.goto(RP_URL);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.waitForURL(`${GATEWAY_URL}/login?**`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  if (create) await page.getByLabel("Create account").check();
  await page.getByRole("button", { name: "Sign on" }).click();
}

/** The login page's verdict: its error text, or null once the assertion is on the page. */
async function verdict(): Promise<string | null> {
  const settled = page.locator(".error, .token").first();
  await settled.waitFor();
  return (await settled.evaluate((el) => el.classList.contains("error"))) ? settled.innerText() : null;
}

/** "Return to the relying party": the callback, the code exchange, and the claims it shows. */
async function returnToRp(): Promise<string> {
  await page.getByRole("button", { name: "Return to the relying party" }).click();
  await page.waitForURL(`${RP_URL}/callback?**`);
  return page.locator("body").innerText();
}

describe("a new user at the relying party", () => {
  it("creates the account, signs in, refreshes, and cannot replay the callback", async () => {
    await signOn(USER, PASSWORD, true);
    expect(await verdict()).toBeNull();
    expect(await page.locator(".trace").innerText()).not.toContain(PASSWORD);

    const claims = await returnToRp();
    sub = /sub\s+(\S+)/.exec(claims)?.[1] as string;
    expect(sub).toBeTruthy();
    expect(claims).toContain(SCOPE);
    const callbackUrl = page.url();

    await page.getByRole("button", { name: "Refresh" }).click();
    await page.waitForURL(`${RP_URL}/refresh`);
    expect(await page.locator("body").innerText()).toContain(sub);

    const replay = await page.goto(callbackUrl);
    expect(replay?.status()).toBe(400);
    expect(await page.locator("body").innerText()).toContain("unknown state");

    expect(logs()).not.toContain(PASSWORD);
  });

  it("signs in again without creating, as the same sub", async () => {
    await signOn(USER, PASSWORD);
    expect(await verdict()).toBeNull();
    expect(await returnToRp()).toContain(sub);
  });

  it("cannot take a username that exists", async () => {
    await signOn(USER, "another password", true);
    expect(await verdict()).toContain("is taken");
  });

  it("is refused with a wrong password, in the browser, before anything reaches the relying party", async () => {
    await signOn(USER, "wrong");
    expect(await verdict()).toContain("wrong password");
    expect(new URL(page.url()).origin).toBe(GATEWAY_URL);
  });

  it("is refused as an unknown user", async () => {
    await signOn("nobody-" + USER, PASSWORD);
    expect(await verdict()).toContain("User not found");
  });
});

describe("with nodes going down", () => {
  it("still signs in with two of three nodes, but cannot register a new user", async () => {
    stopNode(3);
    await signOn(USER, PASSWORD);
    expect(await verdict()).toBeNull();
    expect(await returnToRp()).toContain(sub);

    await signOn(`${USER}-late`, PASSWORD, true);
    expect(await verdict()).toContain("unreachable");
  });

  it("is refused with one of three", async () => {
    stopNode(2);
    await signOn(USER, PASSWORD);
    expect(await verdict()).toContain("quorum 1 < 2");
  });
});
