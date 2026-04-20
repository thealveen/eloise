import { describe, expect, it } from "vitest";
import type { Logger, NormalizedEvent } from "../types/index.js";
import { createSessionResolver } from "./index.js";
import { openSessionDb } from "./sqlite.js";
import { createResolverFromDb, slackKey } from "./resolver.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function silentLogger(): Logger {
  return {
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function makeEvent(
  channel_id: string,
  thread_ts: string,
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    source: "channel",
    channel_id,
    thread_ts,
    message_ts: thread_ts,
    user_id: "U123",
    text: "hello",
    ...overrides,
  };
}

describe("createSessionResolver", () => {
  it("creates a new session on first resolve", async () => {
    const resolver = createSessionResolver({ dbPath: ":memory:", logger: silentLogger() });
    const handle = await resolver.resolve(makeEvent("C1", "1700000000.000001"));

    expect(handle.is_new).toBe(true);
    expect(handle.session_id).toMatch(UUID_V4);
    expect(handle.slack_key).toBe("C1:1700000000.000001");
  });

  it("returns the same session on repeated resolve for the same event", async () => {
    const resolver = createSessionResolver({ dbPath: ":memory:", logger: silentLogger() });
    const event = makeEvent("C1", "1700000000.000001");

    const first = await resolver.resolve(event);
    const second = await resolver.resolve(event);

    expect(first.is_new).toBe(true);
    expect(second.is_new).toBe(false);
    expect(second.session_id).toBe(first.session_id);
  });

  it("updates last_used_at on each resolve", async () => {
    const sdb = openSessionDb(":memory:");
    let now = 1000;
    const resolver = createResolverFromDb(sdb, silentLogger(), () => now);
    const event = makeEvent("C1", "1700000000.000001");
    const key = slackKey(event.channel_id, event.thread_ts);

    await resolver.resolve(event);
    const afterCreate = sdb.db
      .prepare<[string], { created_at: number; last_used_at: number }>(
        "SELECT created_at, last_used_at FROM thread_sessions WHERE slack_key = ?",
      )
      .get(key);
    expect(afterCreate).toEqual({ created_at: 1000, last_used_at: 1000 });

    now = 1050;
    await resolver.resolve(event);
    const afterUpdate = sdb.db
      .prepare<[string], { created_at: number; last_used_at: number }>(
        "SELECT created_at, last_used_at FROM thread_sessions WHERE slack_key = ?",
      )
      .get(key);
    expect(afterUpdate).toEqual({ created_at: 1000, last_used_at: 1050 });
  });

  it("exists() returns false before resolve and true after", async () => {
    const resolver = createSessionResolver({ dbPath: ":memory:", logger: silentLogger() });

    expect(await resolver.exists("C1", "1700000000.000001")).toBe(false);
    await resolver.resolve(makeEvent("C1", "1700000000.000001"));
    expect(await resolver.exists("C1", "1700000000.000001")).toBe(true);
    expect(await resolver.exists("C1", "1700000000.000002")).toBe(false);
  });

  it("produces different sessions for different channels with the same thread_ts", async () => {
    const resolver = createSessionResolver({ dbPath: ":memory:", logger: silentLogger() });

    const a = await resolver.resolve(makeEvent("C1", "1700000000.000001"));
    const b = await resolver.resolve(makeEvent("C2", "1700000000.000001"));

    expect(a.session_id).not.toBe(b.session_id);
    expect(a.slack_key).not.toBe(b.slack_key);
    expect(b.is_new).toBe(true);
  });

  it("produces different sessions for different threads in the same channel", async () => {
    const resolver = createSessionResolver({ dbPath: ":memory:", logger: silentLogger() });

    const a = await resolver.resolve(makeEvent("C1", "1700000000.000001"));
    const b = await resolver.resolve(makeEvent("C1", "1700000000.000002"));

    expect(a.session_id).not.toBe(b.session_id);
    expect(b.is_new).toBe(true);
  });

  it("update() overwrites the session_id for an existing row", async () => {
    const resolver = createSessionResolver({ dbPath: ":memory:", logger: silentLogger() });
    const event = makeEvent("C1", "1700000000.000001");

    const first = await resolver.resolve(event);
    await resolver.update(first.slack_key, "sdk-real-id");

    const after = await resolver.resolve(event);
    expect(after.session_id).toBe("sdk-real-id");
    expect(after.is_new).toBe(false);
  });

  it("drop() removes the row so the next resolve is a fresh session", async () => {
    const resolver = createSessionResolver({ dbPath: ":memory:", logger: silentLogger() });
    const event = makeEvent("C1", "1700000000.000001");

    const first = await resolver.resolve(event);
    expect(first.is_new).toBe(true);
    await resolver.drop(first.slack_key);
    expect(await resolver.exists("C1", "1700000000.000001")).toBe(false);

    const second = await resolver.resolve(event);
    expect(second.is_new).toBe(true);
    expect(second.session_id).not.toBe(first.session_id);
  });
});
