/**
 * Structured JSON logger.
 *
 * Emits newline-delimited JSON (NDJSON) to stdout, which pm2 captures and
 * forwards to `pm2 logs` / journalctl. Per spec §9 hard constraints:
 *   - stdout only (no files, no log shipping, no external services)
 *   - single line per entry (machine-readable)
 *   - no ANSI / colors (production logs)
 *   - secrets redacted by field name
 *
 * Design: a closure-based factory rather than a class. The logger is created
 * once at startup in src/index.ts and passed into every component factory, so
 * we only ever have one instance and don't need the ceremony of a class.
 */

import type { LogEvent, LogLevel, Logger } from "../types/index.js";

/**
 * Numeric ordering for level filtering. A log call is dropped when its level
 * is strictly below the configured threshold (e.g. debug calls drop when the
 * logger is configured at `info`).
 */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

/**
 * Any structured field whose name matches this pattern is redacted. This is
 * the spec §9 minimum: a name-based heuristic that catches the common cases
 * (apiKey, auth_token, client_secret, password) without needing the caller
 * to remember to scrub.
 */
const SECRET_KEY_RE = /token|key|secret|password/i;

/**
 * Field names that match SECRET_KEY_RE but are known identifiers rather than
 * credentials. `slack_key` is the channel+thread composite key from spec §9;
 * it's an identifier for correlating turns, not a secret, so it must pass
 * through to logs unredacted.
 */
const SECRET_ALLOWLIST = new Set<string>(["slack_key"]);

function isSecretField(name: string): boolean {
  if (SECRET_ALLOWLIST.has(name)) return false;
  return SECRET_KEY_RE.test(name);
}

/**
 * Prepares a single field value for JSON output.
 *
 * The notable case is Error instances: `JSON.stringify` on an Error produces
 * `{}` because `message` and `stack` are non-enumerable. We expand them
 * explicitly so crashes show up in logs with enough detail to debug.
 */
function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  return value;
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = isSecretField(k) ? "[redacted]" : serializeValue(v);
  }
  return out;
}

/**
 * Creates a Logger configured at the given minimum level.
 *
 * The returned logger is stateless beyond the level threshold — it's safe to
 * share across components and concurrent turns. Each call produces exactly
 * one NDJSON line on stdout (or zero, if filtered).
 */
export function createLogger(opts: { level: LogLevel }): Logger {
  const threshold = LEVEL_ORDER[opts.level];

  function emit(
    level: LogLevel,
    message: string,
    fields: Partial<LogEvent> = {},
  ): void {
    if (LEVEL_ORDER[level] < threshold) return;

    // Order matters for human readability when tailing logs: timestamp,
    // level, and message lead so the eye can scan the left column.
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...sanitize(fields as Record<string, unknown>),
    };

    // Single write per entry. Using process.stdout.write rather than
    // console.log avoids any possibility of extra formatting and keeps
    // output strictly NDJSON.
    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  return {
    log(event) {
      // Raw LogEvent path: split off the core fields so they don't also
      // appear in the spread of extras.
      const { level, message, ...rest } = event;
      emit(level, message, rest);
    },
    debug(msg, fields) {
      emit("debug", msg, fields);
    },
    info(msg, fields) {
      emit("info", msg, fields);
    },
    warn(msg, fields) {
      emit("warn", msg, fields);
    },
    error(msg, fields) {
      emit("error", msg, fields);
    },
  };
}
