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
});
