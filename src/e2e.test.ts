// Implements spec §10.6 — end-to-end smoke.
//
// Wires real factories (logger, prompt loader, session resolver, agent runner,
// event handler) and mocks only the two external boundaries: the Claude Agent
// SDK and the Slack WebClient. Verifies the pipeline flows state correctly
// across two turns in the same thread — the first turn creates a session row
// in SQLite, the second resumes it via the SDK's `resume` option.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every call the SDK mock sees so tests can assert on the `resume`
// option across turns. Each test overrides `mockStream` to shape the yielded
// messages.
type QueryCall = { options: { resume?: string; [k: string]: unknown } };
const queryCalls: QueryCall[] = [];
let mockStream: (call: QueryCall) => AsyncIterable<unknown>;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: QueryCall) => {
    queryCalls.push(opts);
    return mockStream(opts);
  },
}));

// Import AFTER vi.mock so transitive imports see the stubbed SDK.
const { loadSystemPrompt } = await import("./prompt/index.js");
const { loadMcpConfig } = await import("./mcp/index.js");
const { createSessionStores } = await import("./session/index.js");
const { createAgentRunner } = await import("./agent/index.js");
const { createEventHandler } = await import("./slack/handler.js");
const { createDedup } = await import("./slack/dedup.js");

async function* gen(items: unknown[]): AsyncIterable<unknown> {
  for (const it of items) yield it;
}

function silentLogger() {
  return {
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function makeSlackClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

function rawAppMention(overrides: Record<string, unknown> = {}) {
  return {
    type: "app_mention",
    ts: "1700000000.000100",
    channel: "C_E2E",
    channel_type: "channel",
    user: "U_USER",
    text: "<@UBOT> what time is it",
    ...overrides,
  };
}

describe("E2E: real factories, mocked SDK + Slack client", () => {
  let tmpDir: string;
  let promptPath: string;

  beforeEach(() => {
    queryCalls.length = 0;
    tmpDir = mkdtempSync(join(tmpdir(), "slack-bot-e2e-"));
    promptPath = join(tmpDir, "system.md");
    writeFileSync(promptPath, "You are a terse assistant.\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function wireStack() {
    const logger = silentLogger();
    const systemPrompt = loadSystemPrompt(promptPath);
    const mcpConfig = loadMcpConfig({
      SUPABASE_MCP_TOKEN: "sbp_dummy",
    } as NodeJS.ProcessEnv);
    const { sessionResolver, botReplyStore } = createSessionStores({
      dbPath: ":memory:",
      logger,
    });
    const agentRunner = createAgentRunner({
      systemPrompt,
      mcpConfig,
      timeoutMs: 2000,
      cwd: tmpDir,
      anthropicApiKey: "sk-ant-dummy",
      logger,
    });
    const handler = createEventHandler({
      sessionResolver,
      agentRunner,
      logger,
      dedup: createDedup({ ttlMs: 60_000 }),
      botReplyStore,
    });
    return { handler, sessionResolver };
  }

  it("first @mention: session created, reply posted, reaction lifecycle", async () => {
    mockStream = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sdk-first" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "It is late." }] },
        },
        { type: "result", subtype: "success" },
      ]);

    const { handler, sessionResolver } = wireStack();
    const client = makeSlackClient();

    await handler.handle(rawAppMention(), client, "mention");

    expect(queryCalls).toHaveLength(1);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C_E2E",
      thread_ts: "1700000000.000100",
      text: "It is late.",
    });

    // 🤔 added, then removed on success. No ❌.
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "thinking_face", channel: "C_E2E" }),
    );
    expect(client.reactions.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: "thinking_face", channel: "C_E2E" }),
    );
    const addedNames = client.reactions.add.mock.calls.map((c) => c[0].name);
    expect(addedNames).not.toContain("x");

    // Session row actually persisted (real SQLite). Re-resolving the same
    // event should now come back with is_new=false and the same id.
    const second = await sessionResolver.resolve({
      source: "channel",
      channel_id: "C_E2E",
      thread_ts: "1700000000.000100",
      message_ts: "1700000000.000100",
      user_id: "U_USER",
      text: "ignored",
    });
    expect(second.is_new).toBe(false);
  });

  it("follow-up in same thread resumes using the SDK-minted id", async () => {
    mockStream = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sdk-first" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "ack" }] },
        },
        { type: "result", subtype: "success", session_id: "sdk-first" },
      ]);

    const { handler } = wireStack();
    const client = makeSlackClient();

    // Turn 1 — creates session.
    await handler.handle(rawAppMention(), client, "mention");

    // Turn 2 — same thread_ts, different message_ts (a thread reply).
    await handler.handle(
      rawAppMention({
        ts: "1700000000.000200",
        thread_ts: "1700000000.000100",
        text: "and another thing",
      }),
      client,
      "message",
    );

    expect(queryCalls).toHaveLength(2);
    // Turn 1: no `resume` — brand-new thread, SDK mints its own id.
    expect(queryCalls[0].options.resume).toBeUndefined();
    // Turn 2: resume with the SDK's minted id from turn 1, not the UUID
    // our resolver originally inserted.
    expect(queryCalls[1].options.resume).toBe("sdk-first");

    // And we posted two replies, one per turn.
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("agent error: posts friendly message and adds x reaction", async () => {
    mockStream = () => {
      throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    };

    const { handler } = wireStack();
    const client = makeSlackClient();

    await handler.handle(rawAppMention(), client, "mention");

    expect(client.reactions.add.mock.calls.map((c) => c[0].name)).toContain("x");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    // Don't assert on exact wording — it's owned by format.ts. Just that
    // something was posted.
    const posted = client.chat.postMessage.mock.calls[0][0];
    expect(posted.channel).toBe("C_E2E");
    expect(posted.thread_ts).toBe("1700000000.000100");
    expect(typeof posted.text).toBe("string");
    expect(posted.text.length).toBeGreaterThan(0);
  });

  it("first-turn failure drops the session row so retries start clean", async () => {
    mockStream = () => {
      throw new Error("upstream fire");
    };

    const { handler, sessionResolver } = wireStack();
    const client = makeSlackClient();

    await handler.handle(rawAppMention(), client, "mention");

    // Row must NOT exist — keeping it would pin this thread to a UUID the
    // SDK will reject on every future attempt.
    expect(
      await sessionResolver.exists("C_E2E", "1700000000.000100"),
    ).toBe(false);
  });
});
