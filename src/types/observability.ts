export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type LogEvent = {
  level: LogLevel;
  message: string;
  slack_key?: string;
  session_id?: string;
  user_id?: string;
  duration_ms?: number;
  tool_calls?: number;
  status?: "ok" | "error" | "timeout";
  error_message?: string;
  [key: string]: unknown;
};

export interface Logger {
  log(event: LogEvent): void;
  debug(msg: string, fields?: Partial<LogEvent>): void;
  info(msg: string, fields?: Partial<LogEvent>): void;
  warn(msg: string, fields?: Partial<LogEvent>): void;
  error(msg: string, fields?: Partial<LogEvent>): void;
}
