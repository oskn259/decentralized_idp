import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityNode } from "../src/domain/usecase/identity-node.js";
import { DEFAULT_KEY_ID } from "../src/domain/value/node-identity.js";
import { createDemoLog } from "../src/http/demo-log.js";
import { InMemoryRoundStore, InMemoryUserRepository } from "../src/infra/node.js";
import { RunningNode, getJson, postJson, startNode, startNodeFromFixture, stopAll } from "./helpers/http-server.js";
import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { blind } from "@decentralized-idp/sdk/toprf";

/**
 * Transport-level behaviour of `createNodeServer`: routing, method checks and the shape
 * every non-200 response takes. The use-case-level refusals themselves are covered in
 * `usecase.test.ts` and `e2e.test.ts`.
 */

let node: RunningNode;

beforeEach(async () => {
  node = await startNodeFromFixture("node-1.json");
});

afterEach(async () => {
  await stopAll([node]);
});

function validBlinded(): string {
  return base64UrlEncode(blind("password123").blinded.toRawBytes());
}

describe("routing", () => {
  it("answers 404 on an unknown route", async () => {
    const res = await postJson(node.url, "/nope", {});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: expect.stringContaining("Not found") });
  });

  it("answers the health payload on GET /health", async () => {
    const res = await getJson(node.url, "/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", nodeId: 1, groupPublicKey: expect.any(String) });
  });

  it("answers 404, with no Allow header, when the method is wrong on a known path", async () => {
    for (const path of ["/commit", "/sign-on", "/sign"]) {
      const res = await getJson(node.url, path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("allow")).toBeNull();
      expect(res.body.error).toContain("Not found");
    }

    const health = await postJson(node.url, "/health", {});
    expect(health.status).toBe(404);
  });
});

describe("body handling", () => {
  it("answers 400 on a body that is not JSON", async () => {
    const res = await postJson(node.url, "/commit", null, { raw: "{not json" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Request body is not valid JSON" });
  });

  it("answers 400 when a required field is missing", async () => {
    const res = await postJson(node.url, "/commit", {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("roundId");
  });
});

describe("unhandled errors", () => {
  it("answers 500 when a step outside the use-case try/catch throws unexpectedly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: IdentityNode = {
      identity: {
        nodeId: 1,
        secretKeyShare: 1n,
        // `health` encodes this and throws outside `answer`'s try/catch, reaching the 500 handler.
        groupPublicKey: undefined as unknown as Uint8Array,
        issuer: "http://localhost:3000",
        keyId: DEFAULT_KEY_ID,
      },
      users: new InMemoryUserRepository([]),
      rounds: new InMemoryRoundStore(),
      clock: { nowSeconds: () => 0 },
    };
    const running = await startNode(broken, createDemoLog({ nodeId: 1, env: { DEMO_LOG: "0" } }));

    try {
      const res = await getJson(running.url, "/health");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Internal server error" });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      await running.close();
      errorSpy.mockRestore();
    }
  });
});

describe("response shape", () => {
  it("every non-200 body is exactly { error: string }", async () => {
    const cases = [
      await postJson(node.url, "/nope", {}),
      await getJson(node.url, "/commit"),
      await postJson(node.url, "/commit", {}),
      await postJson(node.url, "/commit", null, { raw: "not json" }),
    ];
    for (const res of cases) {
      expect(res.status).not.toBe(200);
      expect(Object.keys(res.body)).toEqual(["error"]);
      expect(typeof res.body.error).toBe("string");
    }
  });

  it("sends application/json with a correct Content-Length", async () => {
    const res = await postJson(node.url, "/commit", { roundId: crypto.randomUUID() });
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(res.text, "utf8"));
  });

  it("answers 200 with a base64url commitment from /commit", async () => {
    const res = await postJson(node.url, "/commit", { roundId: crypto.randomUUID() });
    expect(res.status).toBe(200);
    expect(res.body.nodeId).toBe(1);
    expect(res.body.D).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.E).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("answers 400 for a /sign-on use-case refusal (unknown user)", async () => {
    const roundId = crypto.randomUUID();
    const own = await postJson(node.url, "/commit", { roundId });
    const res = await postJson(node.url, "/sign-on", {
      roundId,
      request: {
        username: "mallory",
        blinded: validBlinded(),
        sessionNonce: base64UrlEncode(crypto.randomBytes(16)),
        cnfJkt: "jkt",
        clientId: "client",
        scope: "openid",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 30,
        commitments: [{ nodeId: own.body.nodeId, D: own.body.D, E: own.body.E }],
        allParticipants: [1],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("User not found on node 1");
  });
});
