import { describe, expect, it } from "vitest";
import { createRpApp } from "../src/http/server.js";

/** The relying party's own HTTP surface, without a gateway: the redirect it builds and the states it refuses. */

const OPTIONS = { gatewayUrl: "http://gateway.test", rpUrl: "http://rp.test", clientId: "demo_client", scope: "openid profile" };

describe("GET /", () => {
  it("links to /login", async () => {
    const res = await createRpApp(OPTIONS).request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/login"');
  });
});

describe("GET /login", () => {
  it("302s to the gateway's /authorize with every required field and a fresh DPoP thumbprint", async () => {
    const res = await createRpApp(OPTIONS).request("/login");
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe("http://gateway.test/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe("demo_client");
    expect(location.searchParams.get("redirect_uri")).toBe("http://rp.test/callback");
    expect(location.searchParams.get("scope")).toBe("openid profile");
    expect(location.searchParams.get("state")).toMatch(/^[0-9a-f-]{36}$/);
    expect(location.searchParams.get("dpop_jkt")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("draws a different state and thumbprint every time", async () => {
    const app = createRpApp(OPTIONS);
    const first = new URL((await app.request("/login")).headers.get("location") as string);
    const second = new URL((await app.request("/login")).headers.get("location") as string);
    expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
    expect(first.searchParams.get("dpop_jkt")).not.toBe(second.searchParams.get("dpop_jkt"));
  });
});

describe("GET /callback", () => {
  it("refuses an unknown state with 400", async () => {
    const res = await createRpApp(OPTIONS).request("/callback?code=whatever&state=nobody-asked");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unknown state");
  });

  it("refuses a missing state with 400", async () => {
    const res = await createRpApp(OPTIONS).request("/callback?code=whatever");
    expect(res.status).toBe(400);
  });
});

describe("POST /refresh", () => {
  it("refuses an unknown session with 400", async () => {
    const res = await createRpApp(OPTIONS).request("/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ session: "nobody" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unknown session");
  });
});
