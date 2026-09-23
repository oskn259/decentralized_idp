import { afterEach, describe, expect, it, vi } from "vitest";
import { NEVER_HELD, colorEnabled, createDemoLog, demoLogEnabled, shortValue } from "../src/http/demo-log.js";

/**
 * The generic shape of the demo trace: the switches that turn it on and off, the column
 * layout `event`/`more`/`reject` share, `startup`'s own line, `shortValue`'s truncation, and
 * that a disabled logger does nothing at all. Per-event line formats (`commit`, `sign-on`,
 * `sign`) are pinned in `tests/endpoint.test.ts`, against the real endpoints that compose
 * them.
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
    const log = createDemoLog({ nodeId: 1 });
    log.event("commit", "round=r0  → D_1,E_1 DDDDDDDD EEEEEEEE");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("commit");
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
    const log = createDemoLog({ nodeId: 1, env: { DEMO_LOG: "0" }, isTty: true, write: sink.write });
    log.startup({ threshold: 2, total: 3, usernames: ["alice"] });
    log.event("commit", "round=r0  → D_1,E_1 DDDDDDDD EEEEEEEE");
    log.more("continuation");
    log.reject("sign-on", "boom");
    expect(log.enabled).toBe(false);
    expect(log.colored).toBe(false);
    expect(sink.lines).toEqual([]);
  });

  it("colours on a TTY, or when FORCE_COLOR is set to anything but 0", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    // Only the literal "0" turns it off; any other non-empty value, even a word that reads
    // like "off", turns it on.
    expect(colorEnabled({ FORCE_COLOR: "false" }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" }, true)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "" }, false)).toBe(false);
  });

  it("emits ANSI escapes only when colour is on, wrapping the same text underneath", () => {
    const plain = capture();
    const plainLog = createDemoLog({ nodeId: 1, env: {}, isTty: false, write: plain.write });
    plainLog.event("commit", "round=round-1  → D_1,E_1 AAAAAAAA BBBBBBBB");
    expect(plain.lines.every((l) => !l.includes("\x1b["))).toBe(true);
    expect(plain.lines[0]).toBe("[node1]   commit    round=round-1  → D_1,E_1 AAAAAAAA BBBBBBBB");

    const colored = capture();
    const coloredLog = createDemoLog({ nodeId: 1, env: { FORCE_COLOR: "1" }, isTty: false, write: colored.write });
    coloredLog.event("commit", "round=round-1  → D_1,E_1 AAAAAAAA BBBBBBBB");
    expect(colored.lines.every((l) => l.includes("\x1b[") && l.endsWith("\x1b[0m"))).toBe(true);
    expect(colored.lines.map((l) => l.replaceAll(/\x1b\[[0-9;]*m/g, ""))).toEqual(plain.lines);
  });

  it("colours both the heading line and its continuation the same way", () => {
    const sink = capture();
    const log = createDemoLog({ nodeId: 2, env: { FORCE_COLOR: "1" }, isTty: false, write: sink.write });
    log.event("sign-on", "sess=3f9a12c0 round=7be1 user=alice");
    log.more("→ B_2=k_2·A 9mZpQw3e");
    expect(sink.lines).toHaveLength(2);
    expect(sink.lines.every((l) => l.includes("\x1b[") && l.endsWith("\x1b[0m"))).toBe(true);
  });

  it("shades the blue by node id", () => {
    const shades = [1, 2, 3].map((nodeId) => {
      const sink = capture();
      createDemoLog({ nodeId, env: { FORCE_COLOR: "1" }, isTty: false, write: sink.write }).reject("sign-on", "no");
      return /\x1b\[38;5;(\d+)m/.exec(sink.lines[0])?.[1];
    });
    expect(new Set(shades).size).toBe(3);
    expect(shades.every((s) => s !== undefined)).toBe(true);
  });
});

describe("event / more column layout", () => {
  it("pads the tag to 9 and the event name to 9, aligning text at column 20", () => {
    const sink = capture();
    const log = createDemoLog({ nodeId: 1, env: {}, isTty: false, write: sink.write });
    log.event("commit", "TEXT");
    log.event("sign-on", "TEXT");
    log.event("sign", "TEXT");
    log.more("MORE");

    expect(sink.lines[0]).toBe("[node1]   commit    TEXT");
    expect(sink.lines[1]).toBe("[node1]   sign-on   TEXT");
    expect(sink.lines[2]).toBe("[node1]   sign      TEXT");
    // 9 (tag) + 1 + 9 (event) + 1 = 20 columns of indent before the continuation's text.
    expect(sink.lines[3]).toBe(`${" ".repeat(20)}MORE`);
  });

  it("prints a refusal as one ✖ line carrying the reason verbatim", () => {
    const sink = capture();
    const log = createDemoLog({ nodeId: 2, env: {}, isTty: false, write: sink.write });
    log.reject("sign-on", "Round abc expired or not found on node 2");
    expect(sink.lines).toEqual(["[node2]   ✖ sign-on rejected: Round abc expired or not found on node 2"]);
  });
});

describe("demo log values", () => {
  it("cuts a value to its first 8 characters, with no ellipsis -- the only mechanism by which any value reaches the log", () => {
    expect(shortValue("k5Qx8vL2abcdef")).toBe("k5Qx8vL2");
    expect(shortValue("k5Qx8vL2abcdef")).toHaveLength(8);
    expect(shortValue("short")).toBe("short");
    expect(shortValue("")).toBe("-");
    expect(shortValue(undefined)).toBe("-");

    // Even a value shaped like a whole secret is truncated the same way: nothing this
    // module writes can carry more than 8 characters of any string handed to it.
    const longSecret = "s".repeat(64);
    expect(shortValue(longSecret)).toBe("ssssssss");
    expect(shortValue(longSecret)).not.toBe(longSecret);
  });

  it("prints the startup line with holds/never, and only there", () => {
    const sink = capture();
    const log = createDemoLog({ nodeId: 1, env: {}, isTty: false, write: sink.write });

    log.startup({ threshold: 2, total: 3, usernames: ["alice", "bob"] });
    expect(sink.lines).toEqual([
      "[node1]   ● up      id=1 t=2/3 users=alice,bob   holds: s_1, k_1, h_1(alice,bob)   " + `never: ${NEVER_HELD}`,
    ]);

    sink.lines.length = 0;
    log.startup({ threshold: 1, total: 1, usernames: [] });
    expect(sink.lines[0]).toContain("users=-");

    // event()/more() only ever write the text they are given -- "never:" is startup's own
    // sentence, not something this module adds to every line.
    sink.lines.length = 0;
    log.event("commit", "round=r0  → D_1,E_1 DDDDDDDD EEEEEEEE");
    log.more("continuation");
    expect(sink.lines.join("\n")).not.toContain("never:");
  });
});
