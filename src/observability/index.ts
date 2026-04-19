import type { LogLevel, Logger } from "../types/index.js";

export function createLogger(opts: { level: LogLevel }): Logger {
  void opts;
  return {
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
