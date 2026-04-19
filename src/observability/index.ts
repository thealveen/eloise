import type { LogEvent, LogLevel, Logger } from "../types/index.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const SECRET_KEY_RE = /token|key|secret|password/i;

// Fields that match SECRET_KEY_RE but are known identifiers, not credentials.
const SECRET_ALLOWLIST = new Set<string>(["slack_key"]);

function isSecretField(name: string): boolean {
  if (SECRET_ALLOWLIST.has(name)) return false;
  return SECRET_KEY_RE.test(name);
}

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

export function createLogger(opts: { level: LogLevel }): Logger {
  const threshold = LEVEL_ORDER[opts.level];

  function emit(
    level: LogLevel,
    message: string,
    fields: Partial<LogEvent> = {},
  ): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...sanitize(fields as Record<string, unknown>),
    };
    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  return {
    log(event) {
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
