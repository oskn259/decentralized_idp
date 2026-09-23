import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { bytesToHex } from "@decentralized-idp/sdk/hex";
import { Group } from "../src/domain/value/group.js";
import { systemClock } from "../src/infra/clock.js";
import { loadGroup } from "../src/infra/group.js";
import { HttpNode, discoverNodes } from "../src/infra/node.js";

/**
 * `loadGroup`, `discoverNodes`, and the exact JSON `HttpNode` sends and accepts, against a
 * hand-rolled HTTP server. The real node answers in e2e.test.ts.
 */

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../node/tests/fixtures/${name}`, import.meta.url));
}

describe("loadGroup", () => {
  it("reads threshold, keyId and the hex group public key, and stamps the given issuer", () => {
    const group = loadGroup(fixturePath("group.json"), "http://localhost:9999");
    expect(group.issuer).toBe("http://localhost:9999");
    expect(group.threshold).toBe(2);
    expect(group.keyId).toBe("pasta-group-key-1");
    expect(bytesToHex(group.groupPublicKey)).toBe("a665f43f13ae9652f8004b9cfbc9bdd2c6fe086e659eb2797e54851f8d21f80a");
  });
});

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface FakeHttpNode {
  url: string;
  requests: RecordedRequest[];
  /** Queue of responses, consumed in order; the last one repeats once exhausted. */
  respond(status: number, body: unknown): void;
  close(): Promise<void>;
}

async function startFakeHttpNode(): Promise<FakeHttpNode> {
  const requests: RecordedRequest[] = [];
  const queue: { status: number; body: unknown }[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.length > 0 ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? "", path: req.url ?? "", body });
      const next = queue.shift() ?? { status: 200, body: {} };
      res.writeHead(next.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond: (status, body) => queue.push({ status, body }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("HttpNode", () => {
  let fake: FakeHttpNode | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("commit: sends { roundId }, decodes D/E, and throws on a nodeId mismatch", async () => {
    fake = await startFakeHttpNode();
    const D = new Uint8Array(32).fill(1);
    const E = new Uint8Array(32).fill(2);
    fake.respond(200, { nodeId: 1, D: base64UrlEncode(D), E: base64UrlEncode(E) });

    const node = new HttpNode(1, fake.url);
    const commitment = await node.commit("round-x");
    expect(fake.requests[0]).toEqual({ method: "POST", path: "/commit", body: { roundId: "round-x" } });
    expect(commitment.D).toEqual(D);
    expect(commitment.E).toEqual(E);

    fake.respond(200, { nodeId: 2, D: base64UrlEncode(D), E: base64UrlEncode(E) });
    await expect(node.commit("round-y")).rejects.toThrow(/answered as node 2, expected 1/);
  });

  it("sign-on: encodes bytes base64url, sends commitments as {nodeId,D,E} strings", async () => {
    fake = await startFakeHttpNode();
    const toprfPartial = new Uint8Array(32).fill(3);
    const ct_i = new Uint8Array(16).fill(4);
    fake.respond(200, {
      nodeId: 1,
      toprfPartial: base64UrlEncode(toprfPartial),
      ct_i: base64UrlEncode(ct_i),
      sub: "usr_alice_12345",
    });

    const node = new HttpNode(1, fake.url);
    const res = await node.signOn({
      roundId: "round-1",
      username: "alice",
      blinded: new Uint8Array(32).fill(9),
      sessionNonce: new Uint8Array(16).fill(8),
      cnfJkt: "jkt-abc",
      clientId: "demo_client",
      scope: "openid",
      iat: 1,
      exp: 31,
      commitments: [{ nodeId: 1, D: new Uint8Array(32).fill(1), E: new Uint8Array(32).fill(2) }],
      allParticipants: [1],
    });

    expect(res).toEqual({ nodeId: 1, toprfPartial, ct_i, sub: "usr_alice_12345" });

    const sent = fake.requests[0];
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/sign-on");
    const body = sent.body as any;
    expect(body.roundId).toBe("round-1");
    expect(typeof body.request.blinded).toBe("string");
    expect(body.request.blinded).toBe(base64UrlEncode(new Uint8Array(32).fill(9)));
    expect(typeof body.request.sessionNonce).toBe("string");
    expect(body.request.commitments).toEqual([{ nodeId: 1, D: base64UrlEncode(new Uint8Array(32).fill(1)), E: base64UrlEncode(new Uint8Array(32).fill(2)) }]);
  });

  it("sign: authorization_code sends `assertion`, refresh_token sends `refreshToken`, and decodes at/rt as hex bigints", async () => {
    fake = await startFakeHttpNode();
    fake.respond(200, { nodeId: 1, at: "000000000000000000000000000000000000000000000000000000000000002a", rt: "00000000000000000000000000000000000000000000000000000000000000ff" });

    const node = new HttpNode(1, fake.url);
    const shares = await node.sign({
      accessRoundId: "ar",
      refreshRoundId: "rr",
      grant: "authorization_code",
      credential: "assertion.jwt.here",
      dpopProof: "proof.jwt.here",
      claims: { iat: 1, exp: 3601, jti: "j1" },
      commitments: [{ nodeId: 1, D: new Uint8Array(32).fill(1), E: new Uint8Array(32).fill(2) }],
      refreshCommitments: [{ nodeId: 1, D: new Uint8Array(32).fill(3), E: new Uint8Array(32).fill(4) }],
      allParticipants: [1],
    });
    expect(shares.accessShare).toBe(42n);
    expect(shares.refreshShare).toBe(255n);

    const authzBody = fake.requests[0].body as any;
    expect(authzBody.request.assertion).toBe("assertion.jwt.here");
    expect(authzBody.request.refreshToken).toBeUndefined();
    expect(authzBody.roundId).toBe("ar");
    expect(authzBody.refreshRoundId).toBe("rr");

    fake.respond(200, { nodeId: 1, at: "0000000000000000000000000000000000000000000000000000000000000001", rt: "0000000000000000000000000000000000000000000000000000000000000002" });
    await node.sign({
      accessRoundId: "ar2",
      refreshRoundId: "rr2",
      grant: "refresh_token",
      credential: "refresh.jwt.here",
      dpopProof: "proof.jwt.here",
      claims: { iat: 1, exp: 901, jti: "j2" },
      commitments: [],
      refreshCommitments: [],
      allParticipants: [1],
    });
    const refreshBody = fake.requests[1].body as any;
    expect(refreshBody.request.refreshToken).toBe("refresh.jwt.here");
    expect(refreshBody.request.assertion).toBeUndefined();
  });

  it("throws an Error carrying the node's error on a non-2xx response", async () => {
    fake = await startFakeHttpNode();
    fake.respond(400, { error: "boom: bad request" });
    const node = new HttpNode(7, fake.url);
    await expect(node.commit("r")).rejects.toThrow(/node 7 \/commit 400: boom: bad request/);
  });

  it("falls back to the HTTP status text when a non-2xx body carries no error field", async () => {
    fake = await startFakeHttpNode();
    fake.respond(500, {});
    const node = new HttpNode(7, fake.url);
    await expect(node.commit("r")).rejects.toThrow(/node 7 \/commit 500: Internal Server Error/);
  });

  it("refuses a 200 answer that does not fit the node API schema, naming node, path and problem", async () => {
    fake = await startFakeHttpNode();
    fake.respond(200, { nodeId: 2, D: "AAAA", E: base64UrlEncode(new Uint8Array(32)) });
    const node = new HttpNode(2, fake.url);
    await expect(node.commit("r")).rejects.toThrow(/^node 2 \/commit answered malformed: D must decode to 32 bytes, got 3$/);

    fake.respond(200, { nodeId: 2, at: "not-hex", rt: "0".repeat(64) });
    await expect(
      node.sign({
        accessRoundId: "ar",
        refreshRoundId: "rr",
        grant: "authorization_code",
        credential: "assertion.jwt.here",
        dpopProof: "proof.jwt.here",
        claims: { iat: 1, exp: 3601, jti: "j1" },
        commitments: [],
        refreshCommitments: [],
        allParticipants: [2],
      })
    ).rejects.toThrow(/^node 2 \/sign answered malformed: at must be 64 lowercase hex digits$/);

    fake.respond(200, { nodeId: 2, groupPublicKey: base64UrlEncode(new Uint8Array(32)) });
    await expect(node.health()).rejects.toThrow(/^node 2 \/health answered malformed: status /);
  });

  it("throws an Error mentioning 'unreachable' when the node cannot be reached at all", async () => {
    const node = new HttpNode(1, "http://127.0.0.1:1"); // nothing listens on privileged port 1
    await expect(node.commit("r")).rejects.toThrow(/unreachable/);
  });

  it("health: decodes nodeId and groupPublicKey", async () => {
    fake = await startFakeHttpNode();
    const key = new Uint8Array(32).fill(5);
    fake.respond(200, { status: "ok", nodeId: 3, groupPublicKey: base64UrlEncode(key) });
    const node = new HttpNode(3, fake.url);
    const health = await node.health();
    expect(health).toEqual({ nodeId: 3, groupPublicKey: key });
    expect(fake.requests[0]).toEqual({ method: "GET", path: "/health", body: undefined });
  });
});

describe("discoverNodes", () => {
  const GROUP: Group = { issuer: "http://localhost:3000", threshold: 2, keyId: "pasta-group-key-1", groupPublicKey: new Uint8Array(32).fill(9) };

  function healthServer(nodeId: number, groupPublicKey: Uint8Array): http.Server {
    return http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", nodeId, groupPublicKey: base64UrlEncode(groupPublicKey) }));
    });
  }

  async function serveHealth(nodeId: number, groupPublicKey: Uint8Array): Promise<{ url: string; close: () => Promise<void> }> {
    const server = healthServer(nodeId, groupPublicKey);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  /** A port nothing listens on: bound once, then released. */
  async function freePort(): Promise<number> {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it("resolves each node's own id from /health, sorted ascending", async () => {
    const a = await serveHealth(2, GROUP.groupPublicKey);
    const b = await serveHealth(1, GROUP.groupPublicKey);
    try {
      const nodes = await discoverNodes([a.url, b.url], GROUP, 5, 10, () => {});
      expect(nodes.map((n) => n.nodeId)).toEqual([1, 2]);
      expect(nodes.find((n) => n.nodeId === 1)!.url).toBe(b.url);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("retries a node that starts answering only after a delay", async () => {
    // Nothing listens on this port until two attempts have failed.
    const port = await freePort();
    const server = healthServer(5, GROUP.groupPublicKey);
    const startLate = setTimeout(() => server.listen(port, "127.0.0.1"), 30);

    try {
      const nodes = await discoverNodes([`http://127.0.0.1:${port}`], GROUP, 10, 15, () => {});
      expect(nodes.map((n) => n.nodeId)).toEqual([5]);
    } finally {
      clearTimeout(startLate);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("throws when a node reports a different group key than group.json", async () => {
    const wrongKey = new Uint8Array(32).fill(1);
    const node = await serveHealth(1, wrongKey);
    try {
      await expect(discoverNodes([node.url], GROUP, 3, 5, () => {})).rejects.toThrow(/different group key/);
    } finally {
      await node.close();
    }
  });

  it("throws when two node URLs report the same nodeId", async () => {
    const a = await serveHealth(1, GROUP.groupPublicKey);
    const b = await serveHealth(1, GROUP.groupPublicKey);
    try {
      await expect(discoverNodes([a.url, b.url], GROUP, 3, 5, () => {})).rejects.toThrow(/same nodeId/);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("throws naming the URLs still unreachable after exhausting its attempts", async () => {
    await expect(discoverNodes(["http://127.0.0.1:1"], GROUP, 2, 5, () => {})).rejects.toThrow(/unreachable: http:\/\/127\.0\.0\.1:1/);
  });
});

describe("systemClock", () => {
  it("reports whole seconds close to wall time", () => {
    const before = Math.floor(Date.now() / 1000);
    const now = systemClock.nowSeconds();
    expect(Number.isInteger(now)).toBe(true);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(before + 2);
  });
});
