import { afterEach, describe, expect, it, vi } from "vitest";
import { NEVER_HELD, colorEnabled, createDemoLog, demoLogEnabled, excludedPhrase, shortValue } from "../src/http/demo-log.js";

/**
 * The shape every demo line shares: the on/off switches, the column layout, `startup`'s
 * line, `shortValue` and `excludedPhrase`. Each endpoint's own wording is pinned in
 * http.test.ts and e2e.test.ts.
 */

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("default options", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to process.env, console.log and process.stdout.isTTY when not given explicitly", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createDemoLog();
    log.event("authorize", "client_id=demo_client");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("authorize");
  });
});

describe("demo log switches", () => {
  it("is on by default and off only with DEMO_LOG=0", () => {
    expect(demoLogEnabled({})).toBe(true);
    expect(demoLogEnabled({ DEMO_LOG: "1" })).toBe(true);
    expect(demoLogEnabled({ DEMO_LOG: "" })).toBe(true);
    expect(demoLogEnabled({ DEMO_LOG: "0" })).toBe(false);
  });

  it("writes nothing at all when disabled", () => {
    const sink = capture();
    const log = createDemoLog({ env: { DEMO_LOG: "0" }, isTty: true, write: sink.write });
    log.startup({ issuer: "http://localhost:3000", threshold: 2, total: 3, keyId: "pasta-group-key-1" });
    log.event("authorize", "text");
    log.more("continuation");
    log.reject("sign-on", "boom");
    expect(sink.lines).toEqual([]);
  });

  it("colours on a TTY, or when FORCE_COLOR is set to anything but 0", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "false" }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" }, true)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "" }, false)).toBe(false);
  });

  it("emits ANSI escapes only when colour is on, wrapping the same text underneath", () => {
    const plain = capture();
    const plainLog = createDemoLog({ env: {}, isTty: false, write: plain.write });
    plainLog.event("authorize", "client_id=demo_client");
    expect(plain.lines.every((l) => !l.includes("\x1b["))).toBe(true);
    // "authorize" fills the 9-character event column exactly, so only the separating space follows.
    expect(plain.lines[0]).toBe("[gateway] authorize client_id=demo_client");

    const colored = capture();
    const coloredLog = createDemoLog({ env: { FORCE_COLOR: "1" }, isTty: false, write: colored.write });
    coloredLog.event("authorize", "client_id=demo_client");
    expect(colored.lines.every((l) => l.includes("\x1b[") && l.endsWith("\x1b[0m"))).toBe(true);
    expect(colored.lines.map((l) => l.replaceAll(/\x1b\[[0-9;]*m/g, ""))).toEqual(plain.lines);
  });

  it("colours both the heading line and its continuation the same way", () => {
    const sink = capture();
    const log = createDemoLog({ env: { FORCE_COLOR: "1" }, isTty: false, write: sink.write });
    log.event("sign-on", "round=abc user=alice");
    log.more("→ round1 ...");
    expect(sink.lines).toHaveLength(2);
    expect(sink.lines.every((l) => l.includes("\x1b[") && l.endsWith("\x1b[0m"))).toBe(true);
  });

  it("colours a rejection the same way as an event", () => {
    const sink = capture();
    const log = createDemoLog({ env: { FORCE_COLOR: "1" }, isTty: false, write: sink.write });
    log.reject("token", "invalid_grant: bad credential");
    expect(sink.lines).toEqual(["\x1b[1m\x1b[35m[gateway] ✖ token rejected: invalid_grant: bad credential\x1b[0m"]);
  });
});

describe("event / more column layout", () => {
  it("pads the event name to 9, aligning text at column 20", () => {
    const sink = capture();
    const log = createDemoLog({ env: {}, isTty: false, write: sink.write });
    log.event("authorize", "TEXT");
    log.event("sign-on", "TEXT");
    log.event("token", "TEXT");
    log.more("MORE");

    expect(sink.lines[0]).toBe("[gateway] authorize TEXT");
    expect(sink.lines[1]).toBe("[gateway] sign-on   TEXT");
    expect(sink.lines[2]).toBe("[gateway] token     TEXT");
    // "[gateway]" (9) + space + event (9) + space = 20 columns.
    expect(sink.lines[3]).toBe(`${" ".repeat(20)}MORE`);
  });

  it("prints a refusal as one ✖ line carrying the reason verbatim", () => {
    const sink = capture();
    const log = createDemoLog({ env: {}, isTty: false, write: sink.write });
    log.reject("sign-on", "quorum 1 < 2 (node2, node3 unreachable)");
    expect(sink.lines).toEqual(["[gateway] ✖ sign-on rejected: quorum 1 < 2 (node2, node3 unreachable)"]);
  });
});

describe("demo log values", () => {
  it("cuts a value to its first 8 characters, with no ellipsis", () => {
    expect(shortValue("k5Qx8vL2abcdef")).toBe("k5Qx8vL2");
    expect(shortValue("k5Qx8vL2abcdef")).toHaveLength(8);
    expect(shortValue("short")).toBe("short");
    expect(shortValue("")).toBe("-");
    expect(shortValue(undefined)).toBe("-");

    const longSecret = "s".repeat(64);
    expect(shortValue(longSecret)).toBe("ssssssss");
    expect(shortValue(longSecret)).not.toBe(longSecret);
  });

  it("prints the startup line with holds/never, and only there", () => {
    const sink = capture();
    const log = createDemoLog({ env: {}, isTty: false, write: sink.write });

    log.startup({ issuer: "http://localhost:3000", threshold: 2, total: 3, keyId: "pasta-group-key-1" });
    expect(sink.lines).toEqual([
      "[gateway] ● up      t=2/3 issuer=http://localhost:3000   holds: group pubkey, kid=pasta-group-key-1   " +
        `never: ${NEVER_HELD}`,
    ]);

    sink.lines.length = 0;
    log.event("authorize", "text");
    log.more("continuation");
    expect(sink.lines.join("\n")).not.toContain("never:");
  });
});

describe("excludedPhrase", () => {
  it("is empty when nothing was excluded", () => {
    expect(excludedPhrase([])).toBe("");
  });

  it("names one excluded node", () => {
    expect(excludedPhrase([3])).toBe(" (node3 unreachable, excluded)");
  });

  it("names several excluded nodes in the order given", () => {
    expect(excludedPhrase([2, 3])).toBe(" (node2, node3 unreachable, excluded)");
  });
});
