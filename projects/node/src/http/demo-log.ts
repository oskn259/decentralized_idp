/**
 * The demo trace: one or two English lines per event, so the node, gateway, rp and
 * browser columns of a tmux screen can be read side by side. The point is what each
 * component does *not* have, stated once on the `● up` line as `never:`.
 *
 * This module only writes lines; each endpoint composes its own. Only values already on
 * the wire are printed, cut to 8 characters. Long-lived secrets (s_i, k_i, h_i) and the
 * password never reach this module.
 */

export type LogSink = (line: string) => void;

export interface DemoLogEnv {
  DEMO_LOG?: string | undefined;
  FORCE_COLOR?: string | undefined;
}

export interface DemoLogOptions {
  nodeId: number;
  env?: DemoLogEnv;
  /** Whether stdout is a terminal. Defaults to `process.stdout.isTTY`. */
  isTty?: boolean | undefined;
  write?: LogSink;
}

export const NEVER_HELD = "pw, h, other s_i/k_i, sessions, access tokens";

const VALUE_PREFIX_LENGTH = 8;
const TAG_WIDTH = 9;
const EVENT_WIDTH = 9;
const CONTINUATION_INDENT = " ".repeat(TAG_WIDTH + 1 + EVENT_WIDTH + 1);

/** First 8 characters, no ellipsis. Only for per-session values, never for key material. */
export function shortValue(value: string | undefined): string {
  if (value === undefined || value === "") return "-";
  return value.slice(0, VALUE_PREFIX_LENGTH);
}

/** `DEMO_LOG=0` turns the trace off; anything else leaves it on. */
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
/** Blue, deeper with the node id. */
const NODE_SHADES = [117, 75, 33];

function nodeColor(nodeId: number): string {
  // The double modulo keeps the index in range for ids of 0 or below as well.
  const index = (((Math.trunc(nodeId) - 1) % NODE_SHADES.length) + NODE_SHADES.length) % NODE_SHADES.length;
  return `\x1b[38;5;${NODE_SHADES[index]}m`;
}

export interface StartupInfo {
  threshold: number;
  total: number;
  usernames: string[];
}

export interface DemoLog {
  readonly enabled: boolean;
  readonly colored: boolean;
  startup(info: StartupInfo): void;
  /** First line of an event: `[nodeN]   <event>    <text>`. */
  event(name: string, text: string): void;
  /** A further line of the same event, indented to the text column. */
  more(text: string): void;
  /** A refusal: `[nodeN] ✖ <event> rejected: <reason>`. */
  reject(event: string, reason: string): void;
}

/** A disabled logger keeps the same shape and does nothing, so callers never branch. */
export function createDemoLog(options: DemoLogOptions): DemoLog {
  const env = options.env ?? (process.env as DemoLogEnv);
  const write = options.write ?? ((line: string) => console.log(line));
  const isTty = options.isTty ?? Boolean(process.stdout.isTTY);

  const enabled = demoLogEnabled(env);
  if (!enabled) {
    return { enabled, colored: false, startup() {}, event() {}, more() {}, reject() {} };
  }

  const colored = colorEnabled(env, isTty);
  const color = colored ? nodeColor(options.nodeId) : "";
  const tag = `[node${options.nodeId}]`.padEnd(TAG_WIDTH);
  const id = options.nodeId;

  const event = (name: string, text: string): void => {
    const line = `${tag} ${name.padEnd(EVENT_WIDTH)} ${text}`;
    write(colored ? `${BOLD}${color}${line}${RESET}` : line);
  };

  return {
    enabled,
    colored,
    event,

    more(text) {
      const line = `${CONTINUATION_INDENT}${text}`;
      write(colored ? `${color}${line}${RESET}` : line);
    },

    startup(info) {
      const users = info.usernames.join(",") || "-";
      event(
        "● up",
        `id=${id} t=${info.threshold}/${info.total} users=${users}   ` +
          `holds: s_${id}, k_${id}, h_${id}(${users})   never: ${NEVER_HELD}`
      );
    },

    reject(name, reason) {
      const line = `${tag} ✖ ${name} rejected: ${reason}`;
      write(colored ? `${BOLD}${color}${line}${RESET}` : line);
    },
  };
}
