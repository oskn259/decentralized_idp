/**
 * The demo trace: one or two English lines per event, so the node, gateway, rp and
 * browser columns of a tmux screen can be read side by side. The point is what each
 * component does *not* have, stated once on the `● up` line as `never:`.
 *
 * This module only writes lines; each endpoint composes its own. Only values already on
 * the wire are printed, cut to 8 characters.
 */

export interface DemoLogEnv {
  DEMO_LOG?: string | undefined;
  FORCE_COLOR?: string | undefined;
}

export interface DemoLogOptions {
  env?: DemoLogEnv;
  isTty?: boolean | undefined;
  write?: (line: string) => void;
}

export const NEVER_HELD = "s_i, k_i, h_i, pw, sessions";

const VALUE_PREFIX_LENGTH = 8;
const TAG = "[gateway]";
const EVENT_WIDTH = 9;
const CONTINUATION_INDENT = " ".repeat(TAG.length + 1 + EVENT_WIDTH + 1);

/** First 8 characters, no ellipsis. Only for per-session values. */
export function shortValue(value: string | undefined): string {
  if (value === undefined || value === "") return "-";
  return value.slice(0, VALUE_PREFIX_LENGTH);
}

/** ` (node3 unreachable, excluded)` — how a round that went on without a node is shown. */
export function excludedPhrase(excluded: number[]): string {
  if (excluded.length === 0) return "";
  return ` (${excluded.map((id) => `node${id}`).join(", ")} unreachable, excluded)`;
}

export function demoLogEnabled(env: DemoLogEnv): boolean {
  return env.DEMO_LOG !== "0";
}

/** `FORCE_COLOR` decides when set (`0` off, anything else on); otherwise colour only on a TTY. */
export function colorEnabled(env: DemoLogEnv, isTty: boolean): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return env.FORCE_COLOR !== "0";
  return isTty;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";

export interface StartupInfo {
  issuer: string;
  threshold: number;
  total: number;
  keyId: string;
}

export interface DemoLog {
  startup(info: StartupInfo): void;
  /** First line of an event: `[gateway] <event>    <text>`. */
  event(name: string, text: string): void;
  /** A further line of the same event, indented to the text column. */
  more(text: string): void;
  /** A refusal: `[gateway] ✖ <event> rejected: <reason>`. */
  reject(event: string, reason: string): void;
}

/** A disabled logger keeps the same shape and does nothing, so callers never branch. */
export function createDemoLog(options: DemoLogOptions = {}): DemoLog {
  const env = options.env ?? (process.env as DemoLogEnv);
  const write = options.write ?? ((line: string) => console.log(line));
  const isTty = options.isTty ?? Boolean(process.stdout.isTTY);

  if (!demoLogEnabled(env)) {
    return { startup() {}, event() {}, more() {}, reject() {} };
  }
  const colored = colorEnabled(env, isTty);

  const event = (name: string, text: string): void => {
    const line = `${TAG} ${name.padEnd(EVENT_WIDTH)} ${text}`;
    write(colored ? `${BOLD}${MAGENTA}${line}${RESET}` : line);
  };

  return {
    event,

    more(text) {
      const line = `${CONTINUATION_INDENT}${text}`;
      write(colored ? `${MAGENTA}${line}${RESET}` : line);
    },

    startup(info) {
      event(
        "● up",
        `t=${info.threshold}/${info.total} issuer=${info.issuer}   holds: group pubkey, kid=${info.keyId}   never: ${NEVER_HELD}`
      );
    },

    reject(name, reason) {
      const line = `${TAG} ✖ ${name} rejected: ${reason}`;
      write(colored ? `${BOLD}${MAGENTA}${line}${RESET}` : line);
    },
  };
}
