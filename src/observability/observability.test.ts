import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./index.js";

type Entry = Record<string, unknown>;

function captureStdout() {
  const writes: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  return {
    writes,
    restore: () => spy.mockRestore(),
    lines: () => writes.flatMap((w) => w.split("\n").filter(Boolean)),
    entries: (): Entry[] =>
      writes
        .flatMap((w) => w.split("\n").filter(Boolean))
        .map((line) => JSON.parse(line) as Entry),
  };
}

describe("createLogger", () => {
  let cap: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    cap = captureStdout();
  });

  afterEach(() => {
    cap.restore();
  });

  it("drops entries below the configured level", () => {
    const logger = createLogger({ level: "info" });

    logger.debug("should be dropped");
    logger.info("should appear");
    logger.warn("should appear");
    logger.error("should appear");

    const levels = cap.entries().map((e) => e.level);
    expect(levels).toEqual(["info", "warn", "error"]);
  });

  it("emits debug entries when level is debug", () => {
    const logger = createLogger({ level: "debug" });
    logger.debug("hello");
    expect(cap.entries()).toHaveLength(1);
    expect(cap.entries()[0].level).toBe("debug");
  });

  it("writes single-line NDJSON, one entry per call", () => {
    const logger = createLogger({ level: "debug" });
    logger.info("first");
    logger.info("second");

    expect(cap.writes.every((w) => w.endsWith("\n"))).toBe(true);
    expect(cap.writes.every((w) => w.split("\n").filter(Boolean).length === 1)).toBe(true);

    for (const line of cap.lines()) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("includes timestamp, level, and message in every entry", () => {
    const logger = createLogger({ level: "debug" });
    logger.info("hi");

    const entry = cap.entries()[0];
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("hi");
    expect(typeof entry.timestamp).toBe("string");
    expect(() => new Date(entry.timestamp as string).toISOString()).not.toThrow();
  });

  it("passes through structured fields alongside the core fields", () => {
    const logger = createLogger({ level: "debug" });
    logger.info("turn done", {
      slack_key: "C123:ts",
      session_id: "sess-1",
      user_id: "U1",
      duration_ms: 42,
      tool_calls: 3,
      status: "ok",
    });

    const entry = cap.entries()[0];
    expect(entry).toMatchObject({
      level: "info",
      message: "turn done",
      slack_key: "C123:ts",
      session_id: "sess-1",
      user_id: "U1",
      duration_ms: 42,
      tool_calls: 3,
      status: "ok",
    });
  });

  it("redacts fields whose names match token/key/secret/password", () => {
    const logger = createLogger({ level: "debug" });
    logger.info("auth", {
      apiKey: "sk-abc",
      auth_token: "xoxb-1",
      password: "hunter2",
      client_secret: "shh",
      user_id: "U1",
    } as never);

    const entry = cap.entries()[0];
    expect(entry.apiKey).toBe("[redacted]");
    expect(entry.auth_token).toBe("[redacted]");
    expect(entry.password).toBe("[redacted]");
    expect(entry.client_secret).toBe("[redacted]");
    expect(entry.user_id).toBe("U1");
  });

  it("serializes Error instances to message + stack", () => {
    const logger = createLogger({ level: "debug" });
    const err = new Error("boom");
    logger.error("failed", { err } as never);

    const entry = cap.entries()[0];
    const serialized = entry.err as { message: string; stack: string };
    expect(serialized.message).toBe("boom");
    expect(typeof serialized.stack).toBe("string");
    expect(serialized.stack).toContain("boom");
  });

  it("accepts a full LogEvent via log()", () => {
    const logger = createLogger({ level: "debug" });
    logger.log({
      level: "warn",
      message: "slow turn",
      duration_ms: 9001,
      status: "ok",
    });

    const entry = cap.entries()[0];
    expect(entry).toMatchObject({
      level: "warn",
      message: "slow turn",
      duration_ms: 9001,
      status: "ok",
    });
  });

  it("contains no ANSI escape codes", () => {
    const logger = createLogger({ level: "debug" });
    logger.info("hi", { user_id: "U1" });
    const line = cap.lines()[0];
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/\x1b\[/);
  });
});
