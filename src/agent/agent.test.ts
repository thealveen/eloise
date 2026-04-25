import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest, Logger, LogEvent } from "../types/index.js";

// Mock the Agent SDK. Each test overrides `mockQueryImpl` to control stream
// behavior or force throws.
let mockQueryImpl: (opts: unknown) => AsyncIterable<unknown>;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: unknown) => mockQueryImpl(opts),
}));

// Import AFTER vi.mock so the module picks up the mocked SDK.
const { createAgentRunner } = await import("./index.js");

function makeLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  const push = (
    level: LogEvent["level"],
    msg: string,
    fields?: Partial<LogEvent>,
  ) => {
    events.push({ level, message: msg, ...(fields ?? {}) });
  };
  return {
    events,
    log: (e) => events.push(e),
    debug: (m, f) => push("debug", m, f),
    info: (m, f) => push("info", m, f),
    warn: (m, f) => push("warn", m, f),
    error: (m, f) => push("error", m, f),
  };
}

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    session: {
      session_id: "sess-123",
      is_new: false,
      slack_key: "C1:1700000000",
      ...(overrides.session ?? {}),
    },
    user_text: "hello",
    meta: {
      user_id: "U1",
      slack_key: "C1:1700000000",
      ...(overrides.meta ?? {}),
    },
    ...overrides,
  };
}

function makeRunner(overrides: Partial<Parameters<typeof createAgentRunner>[0]> = {}) {
  const logger = makeLogger();
  const runner = createAgentRunner({
    systemPrompt: "you are a bot",
    mcpConfig: {
      servers: [
        {
          name: "supabase",
          transport: "http",
          url: "https://mcp.supabase.com/mcp",
          headers: { Authorization: "Bearer sbp_secret" },
        },
      ],
    },
    timeoutMs: 500,
    cwd: "/tmp",
    anthropicApiKey: "sk-ant-test123secretvalue",
    logger,
    ...overrides,
  });
  return { runner, logger };
}

async function* gen(items: unknown[]): AsyncIterable<unknown> {
  for (const it of items) yield it;
}

// Simulates the CLI streaming a terminal result message and then the
// subprocess dying — the SDK throws from the iterator after the last yield.
async function* genThenThrow(
  items: unknown[],
  err: Error,
): AsyncIterable<unknown> {
  for (const it of items) yield it;
  throw err;
}

describe("createAgentRunner.run", () => {
  beforeEach(() => {
    mockQueryImpl = () => gen([]);
  });

  it("keeps only text emitted after the last tool_use and counts tool calls", async () => {
    // Between-tool narration ("let me check X") should not leak into the
    // Slack reply. The accumulator drops text from messages that contain a
    // tool_use AND resets anything previously accumulated, so only the
    // final synthesis (text-only messages after the last tool call) wins.
    mockQueryImpl = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sess-123" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "narration chunk 1 " }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "narration chunk 2" }] },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "mcp__supabase__query", input: {} }],
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "final " }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "answer" }] },
        },
        { type: "result", session_id: "sess-123" },
      ]);
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe("final answer");
    expect(result.response.tool_calls).toBe(1);
    expect(result.response.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("drops narration text from assistant messages that also contain tool_use", async () => {
    mockQueryImpl = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sess-123" },
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "I'll check the users table first." },
              { type: "tool_use", id: "t1", name: "Bash", input: {} },
            ],
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "42 users." }] },
        },
        { type: "result", session_id: "sess-123" },
      ]);
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe("42 users.");
    expect(result.response.tool_calls).toBe(1);
  });

  it("omits `resume` for brand-new sessions so the SDK mints its own id", async () => {
    let seenOpts: Record<string, unknown> | undefined;
    mockQueryImpl = (opts) => {
      seenOpts = (opts as { options: Record<string, unknown> }).options;
      return gen([
        { type: "system", subtype: "init", session_id: "sdk-new" },
        { type: "result", session_id: "sdk-new" },
      ]);
    };
    const { runner } = makeRunner();
    await runner.run(makeRequest({ session: { session_id: "local-uuid", is_new: true, slack_key: "C1:1" } }));
    expect(seenOpts).toBeDefined();
    expect(seenOpts && "resume" in seenOpts).toBe(false);
  });

  it("passes `resume` for returning sessions", async () => {
    let seenOpts: Record<string, unknown> | undefined;
    mockQueryImpl = (opts) => {
      seenOpts = (opts as { options: Record<string, unknown> }).options;
      return gen([{ type: "result", session_id: "sess-123" }]);
    };
    const { runner } = makeRunner();
    await runner.run(makeRequest({ session: { session_id: "sess-123", is_new: false, slack_key: "C1:1" } }));
    expect(seenOpts?.resume).toBe("sess-123");
  });

  it("returns the SDK's minted id in the response so the handler can persist it", async () => {
    mockQueryImpl = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sdk-xyz" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "ok" }] },
        },
        { type: "result", session_id: "sdk-xyz" },
      ]);
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest({ session: { session_id: "local-uuid", is_new: true, slack_key: "C1:1" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.sdk_session_id).toBe("sdk-xyz");
  });

  it("returns timeout when the SDK stream never yields", async () => {
    mockQueryImpl = () => {
      return (async function* () {
        await new Promise(() => {}); // never resolves
        yield null as unknown;
      })();
    };
    const { runner } = makeRunner({ timeoutMs: 50 });
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
  });

  it("maps 429 to rate_limit", async () => {
    mockQueryImpl = () => {
      throw Object.assign(new Error("rate_limit_exceeded"), { status: 429 });
    };
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("rate_limit");
  });

  it("maps generic 500 to api_error", async () => {
    mockQueryImpl = () => {
      throw Object.assign(new Error("server boom"), { status: 500 });
    };
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("api_error");
    if (result.error.kind === "api_error") {
      expect(result.error.message).toContain("server boom");
    }
  });

  it("maps mcp-flavored errors to mcp_error", async () => {
    mockQueryImpl = () => {
      throw new Error("mcp server 'supabase' is unavailable");
    };
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("mcp_error");
  });

  it("maps unknown errors to unknown", async () => {
    mockQueryImpl = () => {
      throw new Error("wat");
    };
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unknown");
  });

  it("uses result.result as canonical text on subtype:success (overrides concat fallback)", async () => {
    mockQueryImpl = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sess-123" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "stale" }] },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sess-123",
          num_turns: 3,
          result: "canonical answer from SDK",
          is_error: false,
        },
      ]);
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe("canonical answer from SDK");
    expect(result.response.sdk_subtype).toBe("success");
    expect(result.response.sdk_num_turns).toBe(3);
  });

  it("maps error_max_turns subtype to kind:max_turns", async () => {
    mockQueryImpl = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sess-123" },
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          },
        },
        {
          type: "result",
          subtype: "error_max_turns",
          session_id: "sess-123",
          num_turns: 40,
          is_error: true,
          errors: ["max turns reached"],
        },
      ]);
    const { runner, logger } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("max_turns");
    // "agent failed" log should include the SDK subtype and num_turns so
    // future incidents are one-line-diagnosable.
    const failedLog = logger.events.find((e) => e.message === "agent failed");
    expect(failedLog?.sdk_subtype).toBe("error_max_turns");
  });

  it("maps error_during_execution subtype to kind:sdk_error with joined message", async () => {
    mockQueryImpl = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sess-123" },
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "sess-123",
          num_turns: 2,
          is_error: true,
          errors: ["subprocess crashed", "tool handshake failed"],
        },
      ]);
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("sdk_error");
    if (result.error.kind === "sdk_error") {
      expect(result.error.message).toContain("error_during_execution");
      expect(result.error.message).toContain("subprocess crashed");
    }
  });

  it("maps subtype:success + is_error + auth-pattern text to kind:auth_error (wins over subprocess exit)", async () => {
    // The CLI emits a structured result with an auth/usage message, then the
    // subprocess exits 1 and the iterator throws. The structured message must
    // win — otherwise the user sees a generic "unknown" error.
    mockQueryImpl = () =>
      genThenThrow(
        [
          { type: "system", subtype: "init", session_id: "sess-123" },
          {
            type: "result",
            subtype: "success",
            session_id: "sess-123",
            num_turns: 0,
            is_error: true,
            result: "Invalid API key · Please run /login",
            duration_api_ms: 0,
          },
        ],
        new Error("Claude Code process exited with code 1"),
      );
    const { runner, logger } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("auth_error");
    if (result.error.kind === "auth_error") {
      expect(result.error.message).toContain("Invalid API key");
    }
    const failedLog = logger.events.find((e) => e.message === "agent failed");
    expect(failedLog?.error_kind).toBe("auth_error");
  });

  it("maps subtype:success + is_error + generic text to kind:api_error", async () => {
    mockQueryImpl = () =>
      genThenThrow(
        [
          { type: "system", subtype: "init", session_id: "sess-123" },
          {
            type: "result",
            subtype: "success",
            session_id: "sess-123",
            num_turns: 0,
            is_error: true,
            result: "something generic went wrong upstream",
            duration_api_ms: 0,
          },
        ],
        new Error("Claude Code process exited with code 1"),
      );
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("api_error");
    if (result.error.kind === "api_error") {
      expect(result.error.message).toContain("something generic");
    }
  });

  it("agent ok log includes text_length and sdk_subtype", async () => {
    mockQueryImpl = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sess-123" },
        {
          type: "result",
          subtype: "success",
          session_id: "sess-123",
          num_turns: 5,
          result: "hello",
          is_error: false,
        },
      ]);
    const { runner, logger } = makeRunner();
    await runner.run(makeRequest());
    const okLog = logger.events.find((e) => e.message === "agent ok");
    expect(okLog?.text_length).toBe(5);
    expect(okLog?.sdk_subtype).toBe("success");
    expect(okLog?.sdk_num_turns).toBe(5);
  });

  it("never logs the Anthropic API key or MCP bearer token", async () => {
    mockQueryImpl = () => {
      throw new Error(
        "boom with sk-ant-test123secretvalue and Bearer sbp_secret leaked",
      );
    };
    const { runner, logger } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(false);

    const serialized = JSON.stringify(logger.events);
    expect(serialized).not.toContain("sk-ant-test123secretvalue");
    expect(serialized).not.toContain("sbp_secret");

    if (!result.ok && "message" in result.error) {
      expect(result.error.message).not.toContain("sk-ant-test123secretvalue");
      expect(result.error.message).not.toContain("sbp_secret");
    }
  });

  it("logs status=ok on success and status=error on failure", async () => {
    mockQueryImpl = () =>
      gen([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "hi" }] },
        },
      ]);
    const { runner, logger } = makeRunner();
    await runner.run(makeRequest());
    expect(logger.events.some((e) => e.status === "ok")).toBe(true);

    logger.events.length = 0;
    mockQueryImpl = () => {
      throw new Error("wat");
    };
    await runner.run(makeRequest());
    expect(logger.events.some((e) => e.status === "error")).toBe(true);
  });

  it("returns a runner with a run function (smoke)", () => {
    const { runner } = makeRunner();
    expect(typeof runner.run).toBe("function");
  });

  it("invokes onProgress once per tool_use batch with monotonically increasing tool_calls", async () => {
    // Stream with three tool-use batches interleaved with narration/text.
    // Expect three onProgress calls, one per batch, with last_tool reflecting
    // the batch's last tool name and tool_calls counting all tool_use blocks
    // seen so far across the entire run.
    mockQueryImpl = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "Bash", input: {} },
            ],
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "narration" }] },
        },
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t2", name: "mcp__supabase__query", input: {} },
              { type: "tool_use", id: "t3", name: "Read", input: {} },
            ],
          },
        },
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t4", name: "Edit", input: {} },
            ],
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        },
        { type: "result", subtype: "success", result: "done", session_id: "sess-1", num_turns: 4 },
      ]);
    const { runner } = makeRunner();
    const progress: Array<{ tool_calls: number; last_tool?: string }> = [];
    const result = await runner.run(
      makeRequest({ onProgress: (e) => progress.push(e) }),
    );
    expect(result.ok).toBe(true);
    expect(progress).toEqual([
      { tool_calls: 1, last_tool: "Bash" },
      { tool_calls: 3, last_tool: "Read" },
      { tool_calls: 4, last_tool: "Edit" },
    ]);
  });
});
