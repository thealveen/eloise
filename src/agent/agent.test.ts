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

  it("accumulates assistant text and counts tool_use blocks", async () => {
    mockQueryImpl = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sess-123" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello " }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "world" }] },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "mcp__supabase__query", input: {} }],
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "!" }] },
        },
        { type: "result", session_id: "sess-123" },
      ]);
    const { runner } = makeRunner();
    const result = await runner.run(makeRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe("Hello world!");
    expect(result.response.tool_calls).toBe(1);
    expect(result.response.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("logs a warn when the SDK's session id drifts", async () => {
    mockQueryImpl = () =>
      gen([
        { type: "system", subtype: "init", session_id: "sdk-abc" },
        { type: "result", session_id: "sdk-abc" },
      ]);
    const { runner, logger } = makeRunner();
    await runner.run(makeRequest());
    expect(
      logger.events.some(
        (e) => e.level === "warn" && e.sdk_session_id === "sdk-abc",
      ),
    ).toBe(true);
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
