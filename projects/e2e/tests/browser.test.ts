import { Browser, Page, chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SCOPE, Stack, startStack } from "./helpers/stack.js";

/**
 * A person at the relying party's page, in Chromium. One path is driven: "Sign in" → the login
 * page → "Sign on" → "Return to the relying party" → the claims → "Refresh". The cases differ
 * only in what is typed and which nodes are up, so the later tests close nodes and stay last.
 */

let stack: Stack;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  stack = await startStack();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await stack?.close();
});

beforeEach(async () => {
  page = await (await browser.newContext()).newPage();
});

afterEach(async () => {
  await page.context().close();
});

/** From the relying party's page to the login page's verdict on this username and password. */
async function signOn(username: string, password: string): Promise<void> {
  await page.goto(stack.rpUrl);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.waitForURL(`${stack.gatewayUrl}/login?**`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
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
  await page.waitForURL(`${stack.rpUrl}/callback?**`);
  return page.locator("body").innerText();
}

describe("alice at the relying party", () => {
  it("signs in, refreshes, and cannot replay the callback", async () => {
    await signOn("alice", "password123");
    expect(await verdict()).toBeNull();
    expect(await page.locator(".trace").innerText()).not.toContain("password123");

    const claims = await returnToRp();
    expect(claims).toContain("usr_alice_12345");
    expect(claims).toContain(SCOPE);
    const callbackUrl = page.url();

    await page.getByRole("button", { name: "Refresh" }).click();
    await page.waitForURL(`${stack.rpUrl}/refresh`);
    expect(await page.locator("body").innerText()).toContain("usr_alice_12345");

    const replay = await page.goto(callbackUrl);
    expect(replay?.status()).toBe(400);
    expect(await page.locator("body").innerText()).toContain("unknown state");
  });

  it("is refused with a wrong password, in the browser, before anything reaches the relying party", async () => {
    await signOn("alice", "wrong");
    expect(await verdict()).toContain("wrong password");
    expect(new URL(page.url()).origin).toBe(stack.gatewayUrl);
  });

  it("is refused as an unknown user", async () => {
    await signOn("mallory", "password123");
    expect(await verdict()).toContain("User not found");
  });
});

describe("with nodes going down", () => {
  it("still signs in with two of three nodes", async () => {
    await stack.nodes[2].close();
    await signOn("alice", "password123");
    expect(await verdict()).toBeNull();
    expect(await returnToRp()).toContain("usr_alice_12345");
  });

  it("is refused with one of three", async () => {
    await stack.nodes[1].close();
    await signOn("alice", "password123");
    expect(await verdict()).toContain("quorum 1 < 2");
  });
});
