/**
 * Tests for the Slack Adapter.
 *
 * Strategy: never boot Bolt. Test the pure modules (`normalize`, `format`,
 * `dedup`) directly, and test the orchestrator (`handler`) with mock
 * SessionResolver + AgentRunner + a fake Slack client.
 *
 * The factory smoke test is kept as a sanity check that `createSlackAdapter`
 * can be constructed without network I/O — it doesn't call `start()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentError,
  AgentResult,
  AgentRunner,
  Logger,
  NormalizedEvent,
  SessionHandle,
  SessionResolver,
} from "../types/index.js";
import { createDedup } from "./dedup.js";
import { formatErrorMessage } from "./format.js";
import { createEventHandler, type SlackClient } from "./handler.js";
import { isThreadReply, normalize, type RawSlackEvent } from "./normalize.js";

// ---------- shared test fixtures ----------

function makeLogger(): Logger {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeSessionResolver(handle: Partial<SessionHandle> = {}): SessionResolver {
  const full: SessionHandle = {
    session_id: handle.session_id ?? "sess-1",
    is_new: handle.is_new ?? false,
    slack_key: handle.slack_key ?? "C123:1700000000.000100",
  };
  return {
    resolve: vi.fn().mockResolvedValue(full),
    exists: vi.fn().mockResolvedValue(true),
    update: vi.fn().mockResolvedValue(undefined),
    drop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAgentRunner(result: AgentResult): AgentRunner {
  return { run: vi.fn().mockResolvedValue(result) };
}

function makeClient(): SlackClient & {
  chat: { postMessage: ReturnType<typeof vi.fn> };
  reactions: {
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
} {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

// A minimal raw Slack event in a channel with the bot mentioned.
function channelMention(overrides: Partial<RawSlackEvent> = {}): RawSlackEvent {
  return {
    type: "app_mention",
    ts: "1700000000.000100",
    channel: "C123",
    channel_type: "channel",
    user: "U999",
    text: "<@UBOT123> hello there",
    ...overrides,
  };
}

// A DM message from the user (no mention required in a DM).
function dmMessage(overrides: Partial<RawSlackEvent> = {}): RawSlackEvent {
  return {
    type: "message",
    ts: "1700000001.000200",
    channel: "D456",
    channel_type: "im",
    user: "U999",
    text: "hi bot",
    ...overrides,
  };
}

// ---------- normalize ----------

describe("normalize", () => {
  it("strips a leading bot mention from a channel app_mention", () => {
    const out = normalize(channelMention(), null);
    expect(out).toEqual<NormalizedEvent>({
      source: "channel",
      channel_id: "C123",
      thread_ts: "1700000000.000100",
      message_ts: "1700000000.000100",
      user_id: "U999",
      text: "hello there",
    });
  });

  it("aliases thread_ts to ts for top-level messages", () => {
    const out = normalize(channelMention(), null);
    expect(out?.thread_ts).toBe(out?.message_ts);
  });

  it("preserves thread_ts on a thread reply", () => {
    const out = normalize(
      channelMention({
        ts: "1700000005.000500",
        thread_ts: "1700000000.000100",
      }),
      null,
    );
    expect(out?.thread_ts).toBe("1700000000.000100");
    expect(out?.message_ts).toBe("1700000005.000500");
  });

  it("marks DMs as source=dm", () => {
    const out = normalize(dmMessage(), null);
    expect(out?.source).toBe("dm");
  });

  it("strips both U- and W-prefixed mentions, with extra whitespace", () => {
    expect(normalize(channelMention({ text: "<@UBOT123>   hello" }), null)?.text).toBe(
      "hello",
    );
    expect(normalize(channelMention({ text: "<@WBOT123> hello" }), null)?.text).toBe(
      "hello",
    );
  });

  it("does not strip mid-text mentions", () => {
    const out = normalize(
      channelMention({ text: "<@UBOT123> tell <@U777> something" }),
      null,
    );
    expect(out?.text).toBe("tell <@U777> something");
  });

  it("returns null when bot_id is set (other bot)", () => {
    expect(normalize(channelMention({ bot_id: "B12345" }), null)).toBeNull();
  });

  it("returns null when subtype is bot_message", () => {
    expect(normalize(channelMention({ subtype: "bot_message" }), null)).toBeNull();
  });

  it("returns null when subtype is anything else (edits, deletes)", () => {
    expect(normalize(channelMention({ subtype: "message_changed" }), null)).toBeNull();
    expect(normalize(channelMention({ subtype: "message_deleted" }), null)).toBeNull();
    expect(normalize(channelMention({ subtype: "channel_join" }), null)).toBeNull();
  });

  it("returns null when text is empty after stripping", () => {
    expect(normalize(channelMention({ text: "<@UBOT123>" }), null)).toBeNull();
    expect(normalize(channelMention({ text: "<@UBOT123>   " }), null)).toBeNull();
  });

  it("returns null for the bot's own user echoes when botUserId is known", () => {
    expect(normalize(channelMention({ user: "UBOT123" }), "UBOT123")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(normalize({ ...channelMention(), ts: undefined }, null)).toBeNull();
    expect(normalize({ ...channelMention(), channel: undefined }, null)).toBeNull();
    expect(normalize({ ...channelMention(), user: undefined }, null)).toBeNull();
    expect(normalize({ ...channelMention(), text: undefined }, null)).toBeNull();
  });
});

describe("isThreadReply", () => {
  it("is false for a top-level message (no thread_ts)", () => {
    expect(isThreadReply({ ts: "1.0" })).toBe(false);
  });

  it("is false when thread_ts equals ts (top-level being its own root)", () => {
    expect(isThreadReply({ ts: "1.0", thread_ts: "1.0" })).toBe(false);
  });

  it("is true when thread_ts differs from ts (genuine reply)", () => {
    expect(isThreadReply({ ts: "2.0", thread_ts: "1.0" })).toBe(true);
  });
});

// ---------- formatErrorMessage ----------

describe("formatErrorMessage", () => {
  const cases: Array<{ error: AgentError; expected: string }> = [
    { error: { kind: "timeout" }, expected: "Took too long, try again." },
    { error: { kind: "rate_limit" }, expected: "Rate limited, try again shortly." },
    { error: { kind: "api_error", message: "boom" }, expected: "Something went wrong." },
    { error: { kind: "mcp_error", message: "boom" }, expected: "Something went wrong." },
    { error: { kind: "unknown", message: "boom" }, expected: "Something went wrong." },
  ];

  for (const { error, expected } of cases) {
    it(`maps ${error.kind} -> "${expected}"`, () => {
      expect(formatErrorMessage(error)).toBe(expected);
    });
  }
});

// ---------- dedup ----------

describe("dedup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false until marked, true after", () => {
    const d = createDedup({ ttlMs: 1000 });
    expect(d.seen("a")).toBe(false);
    d.mark("a");
    expect(d.seen("a")).toBe(true);
  });

  it("expires entries past the TTL", () => {
    const d = createDedup({ ttlMs: 1000 });
    d.mark("a");
    vi.advanceTimersByTime(1500);
    expect(d.seen("a")).toBe(false);
  });
});

// ---------- handler ----------

describe("event handler", () => {
  it("happy path: mention -> reaction, resolve, run, postMessage in-thread, remove reaction, log ok", async () => {
    const logger = makeLogger();
    const sessionResolver = makeSessionResolver({
      session_id: "sess-1",
      slack_key: "C123:1700000000.000100",
      is_new: false,
    });
    const agentRunner = makeAgentRunner({
      ok: true,
      response: { text: "*hello* user", duration_ms: 42, tool_calls: 1 },
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
    });
    const client = makeClient();

    await handler.handle(channelMention(), client, "mention");

    // 🤔 added then removed.
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1700000000.000100",
      name: "thinking_face",
    });
    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1700000000.000100",
      name: "thinking_face",
    });

    // Resolver received the normalized event.
    expect(sessionResolver.resolve).toHaveBeenCalledTimes(1);

    // Runner received the right session + text.
    expect(agentRunner.run).toHaveBeenCalledWith({
      session: expect.objectContaining({ session_id: "sess-1" }),
      user_text: "hello there",
      meta: { user_id: "U999", slack_key: "C123:1700000000.000100" },
    });

    // postMessage in-thread, text passed through unmodified.
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1700000000.000100",
      text: "*hello* user",
    });

    // No ❌ on success.
    expect(client.reactions.add).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "x" }),
    );

    // One info log line with required fields.
    expect(logger.info).toHaveBeenCalledWith(
      "turn ok",
      expect.objectContaining({
        slack_key: "C123:1700000000.000100",
        session_id: "sess-1",
        user_id: "U999",
        text_preview: "hello there",
        duration_ms: 42,
        tool_calls: 1,
        status: "ok",
      }),
    );
  });

  it("AgentError timeout -> posts 'Took too long, try again.' with ❌", async () => {
    await assertErrorMapping(
      { kind: "timeout" },
      "Took too long, try again.",
      "timeout",
    );
  });

  it("AgentError rate_limit -> posts 'Rate limited, try again shortly.' with ❌", async () => {
    await assertErrorMapping(
      { kind: "rate_limit" },
      "Rate limited, try again shortly.",
      "error",
    );
  });

  it("AgentError api_error -> posts 'Something went wrong.' with ❌", async () => {
    await assertErrorMapping(
      { kind: "api_error", message: "boom" },
      "Something went wrong.",
      "error",
    );
  });

  it("AgentError mcp_error -> posts 'Something went wrong.' with ❌", async () => {
    await assertErrorMapping(
      { kind: "mcp_error", message: "boom" },
      "Something went wrong.",
      "error",
    );
  });

  it("AgentError unknown -> posts 'Something went wrong.' with ❌", async () => {
    await assertErrorMapping(
      { kind: "unknown", message: "boom" },
      "Something went wrong.",
      "error",
    );
  });

  it("ignores duplicate message_ts within TTL (no resolver/runner calls)", async () => {
    const logger = makeLogger();
    const sessionResolver = makeSessionResolver();
    const agentRunner = makeAgentRunner({
      ok: true,
      response: { text: "ok", duration_ms: 1, tool_calls: 0 },
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
    });
    const client = makeClient();

    const event = channelMention();
    await handler.handle(event, client, "mention");
    await handler.handle(event, client, "mention");

    expect(sessionResolver.resolve).toHaveBeenCalledTimes(1);
    expect(agentRunner.run).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("dedups across mention + message double-fire for the same ts", async () => {
    const logger = makeLogger();
    const sessionResolver = makeSessionResolver();
    const agentRunner = makeAgentRunner({
      ok: true,
      response: { text: "ok", duration_ms: 1, tool_calls: 0 },
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
    });
    const client = makeClient();

    const raw = channelMention();
    await handler.handle(raw, client, "mention");
    await handler.handle(raw, client, "message");

    expect(agentRunner.run).toHaveBeenCalledTimes(1);
  });

  // Regression: when Slack delivers the `message.channels` event BEFORE the
  // paired `app_mention` for the same ts, we must not let the gated-out
  // message event burn the dedup slot — otherwise the @mention silently
  // drops and the bot never replies.
  it("processes @mention when message.channels arrives before app_mention", async () => {
    const logger = makeLogger();
    const sessionResolver = makeSessionResolver();
    const agentRunner = makeAgentRunner({
      ok: true,
      response: { text: "ok", duration_ms: 1, tool_calls: 0 },
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
    });
    const client = makeClient();

    const raw = channelMention();
    await handler.handle(raw, client, "message"); // K4 drops without marking
    await handler.handle(raw, client, "mention"); // must still run

    expect(agentRunner.run).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("channel non-mention top-level message is ignored (no reactions, no resolve)", async () => {
    const logger = makeLogger();
    const sessionResolver = makeSessionResolver();
    const agentRunner = makeAgentRunner({
      ok: true,
      response: { text: "ok", duration_ms: 1, tool_calls: 0 },
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
    });
    const client = makeClient();

    // A regular channel message with no thread_ts and no leading mention.
    await handler.handle(
      {
        type: "message",
        ts: "1700000010.000100",
        channel: "C999",
        channel_type: "channel",
        user: "U999",
        text: "just chatting",
      },
      client,
      "message",
    );

    expect(sessionResolver.resolve).not.toHaveBeenCalled();
    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(client.reactions.add).not.toHaveBeenCalled();
  });

  it("channel non-mention thread reply with new session is dropped (K4 gate)", async () => {
    const logger = makeLogger();
    // Resolver creates a row — is_new: true — but K4 says ignore.
    const sessionResolver = makeSessionResolver({ is_new: true });
    const agentRunner = makeAgentRunner({
      ok: true,
      response: { text: "ok", duration_ms: 1, tool_calls: 0 },
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
    });
    const client = makeClient();

    await handler.handle(
      {
        type: "message",
        ts: "1700000020.000100",
        thread_ts: "1700000000.000100",
        channel: "C999",
        channel_type: "channel",
        user: "U999",
        text: "follow-up no mention",
      },
      client,
      "message",
    );

    // 🤔 added then removed; runner never called; no postMessage.
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "thinking_face" }),
    );
    expect(client.reactions.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: "thinking_face" }),
    );
    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("channel non-mention thread reply with existing session continues conversation", async () => {
    const logger = makeLogger();
    const sessionResolver = makeSessionResolver({ is_new: false });
    const agentRunner = makeAgentRunner({
      ok: true,
      response: { text: "continued", duration_ms: 5, tool_calls: 0 },
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
    });
    const client = makeClient();

    await handler.handle(
      {
        type: "message",
        ts: "1700000030.000100",
        thread_ts: "1700000000.000100",
        channel: "C999",
        channel_type: "channel",
        user: "U999",
        text: "follow-up",
      },
      client,
      "message",
    );

    expect(agentRunner.run).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "1700000000.000100",
        text: "continued",
      }),
    );
  });

  it("DM top-level message is processed without requiring a mention", async () => {
    const logger = makeLogger();
    const sessionResolver = makeSessionResolver({ is_new: true });
    const agentRunner = makeAgentRunner({
      ok: true,
      response: { text: "hi back", duration_ms: 1, tool_calls: 0 },
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
    });
    const client = makeClient();

    await handler.handle(dmMessage(), client, "message");

    expect(agentRunner.run).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D456", text: "hi back" }),
    );
  });

  it("when SessionResolver throws: posts 'Something went wrong.', adds ❌, logs error", async () => {
    const logger = makeLogger();
    const sessionResolver: SessionResolver = {
      resolve: vi.fn().mockRejectedValue(new Error("sqlite died")),
    };
    const agentRunner = makeAgentRunner({
      ok: true,
      response: { text: "x", duration_ms: 1, tool_calls: 0 },
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
    });
    const client = makeClient();

    await handler.handle(channelMention(), client, "mention");

    // No agent call (resolver crashed first).
    expect(agentRunner.run).not.toHaveBeenCalled();

    // ❌ + apology posted in-thread.
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "x" }),
    );
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Something went wrong.", thread_ts: expect.any(String) }),
    );

    // Error log line with the underlying message.
    expect(logger.error).toHaveBeenCalledWith(
      "turn error",
      expect.objectContaining({
        status: "error",
        error_message: "sqlite died",
        user_id: "U999",
      }),
    );
  });

  it("setBotUserId enables filtering of own-message echoes", async () => {
    const logger = makeLogger();
    const sessionResolver = makeSessionResolver();
    const agentRunner = makeAgentRunner({
      ok: true,
      response: { text: "x", duration_ms: 1, tool_calls: 0 },
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
    });
    const client = makeClient();

    handler.setBotUserId("UBOT123");
    await handler.handle(channelMention({ user: "UBOT123" }), client, "mention");

    expect(sessionResolver.resolve).not.toHaveBeenCalled();
    expect(agentRunner.run).not.toHaveBeenCalled();
  });
});

// Helper: drives the handler with a single AgentError and asserts the
// resulting Slack-side UX. Centralizes the K12 mapping check.
async function assertErrorMapping(
  error: AgentError,
  expectedText: string,
  expectedStatus: "timeout" | "error",
): Promise<void> {
  const logger = makeLogger();
  const sessionResolver = makeSessionResolver();
  const agentRunner = makeAgentRunner({ ok: false, error });
  const handler = createEventHandler({
    sessionResolver,
    agentRunner,
    logger,
    dedup: createDedup({ ttlMs: 60_000 }),
  });
  const client = makeClient();

  await handler.handle(channelMention(), client, "mention");

  expect(client.reactions.add).toHaveBeenCalledWith(
    expect.objectContaining({ name: "thinking_face" }),
  );
  expect(client.reactions.remove).toHaveBeenCalledWith(
    expect.objectContaining({ name: "thinking_face" }),
  );
  expect(client.reactions.add).toHaveBeenCalledWith(
    expect.objectContaining({ name: "x" }),
  );
  expect(client.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "C123",
      thread_ts: "1700000000.000100",
      text: expectedText,
    }),
  );
  expect(logger.error).toHaveBeenCalledWith(
    `turn ${expectedStatus}`,
    expect.objectContaining({ status: expectedStatus }),
  );
}

// ---------- factory smoke test ----------

describe("createSlackAdapter (factory)", () => {
  it("constructs without network I/O and exposes start/stop", async () => {
    // Lazy import so the smoke test only runs if the rest of the module compiles.
    const { createSlackAdapter } = await import("./index.js");
    const logger = makeLogger();
    const adapter = createSlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      sessionResolver: makeSessionResolver(),
      agentRunner: makeAgentRunner({
        ok: true,
        response: { text: "x", duration_ms: 1, tool_calls: 0 },
      }),
      logger,
    });
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.stop).toBe("function");
  });
});
