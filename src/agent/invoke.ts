// Implements spec §5 Agent Runner.
//
// Agent SDK invocation — session semantics (updated 2026-04-20).
//
//   - query() returns an AsyncGenerator of SDKMessage events.
//   - `resume: "<uuid>"` resumes an on-disk session. If the id is unknown,
//     the SDK now HARD-ERRORS with `No conversation found with session ID`
//     and the subprocess exits with code 1 (older SDK versions silently
//     started a fresh session — do not rely on that).
//   - The SDK mints its own session id for brand-new sessions; there is no
//     documented option to force a caller-supplied UUID onto a new session.
//     The actual session id is reported in the `system` init message and
//     the final `result` message.
//
// Consequence for our flow:
//   - SessionHandle.is_new === true → omit `resume` entirely. Capture the
//     SDK's minted id via the accumulator and propagate it up through
//     AgentResponse.sdk_session_id so the Slack handler can rewrite the
//     SQLite row. Next turn on the same thread will resume cleanly.
//   - is_new === false → pass the stored id (which is now the SDK's own id
//     from a prior successful turn) as `resume`.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRequest, Logger, McpConfig } from "../types/index.js";
import { applyMessage, initAccumulator } from "./accumulate.js";

export type InvokeDeps = {
  systemPrompt: string;
  mcpConfig: McpConfig;
  cwd: string;
  model?: string;
  logger: Logger;
};

export type InvokeResult = {
  text: string;
  tool_calls: number;
  sdk_session_id?: string;
  mcp_servers?: { name: string; status: string }[];
  tools?: string[];
  sdk_subtype?: string;
  sdk_num_turns?: number;
  sdk_is_error?: boolean;
  sdk_duration_api_ms?: number;
  sdk_cost_usd?: number;
};

// Thrown by invokeAgent when the SDK's final result message has a non-success
// subtype (error_max_turns, error_during_execution, ...). Carries the subtype
// so mapError can translate it into the right AgentError kind.
export class SdkResultError extends Error {
  readonly subtype: string;
  readonly errors: string[];
  constructor(subtype: string, errors: string[]) {
    const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
    super(`sdk result ${subtype}${detail}`);
    this.name = "SdkResultError";
    this.subtype = subtype;
    this.errors = errors;
  }
}

// Read-only Slack DB assistant. Keep `Bash` for the `jq` recipe the model
// uses to un-wrap persisted tool results (see prompts/system.md "Persisted
// tool results"); keep `Read` as a fallback. `Write`/`Edit` have no purpose
// here — removing them prevents the model from rabbit-holing into
// file-edit tangents when a query result gets persisted to disk.
const ALLOWED_TOOLS = [
  "mcp__supabase",
  // SDK built-in used to invoke SKILL.md-defined skills. Skill discovery
  // (via settingSources: ["project"] below) and skill invocation are
  // separate permissions — missing this causes "the skill isn't available
  // to invoke here" on resume turns.
  "Skill",
  "Read",
  "Bash",
] as const;

// Scoring 10 applications with MCP schema introspection + per-app validation
// can legitimately need 25+ turns. 20 was too tight and caused silent
// `error_max_turns` aborts. 40 gives breathing room without being unbounded.
const MAX_TURNS = 40;

type SdkMcpServers = Record<
  string,
  {
    type: "http";
    url: string;
    headers?: Record<string, string>;
  }
>;

function toSdkMcpServers(cfg: McpConfig): SdkMcpServers {
  const out: SdkMcpServers = {};
  for (const s of cfg.servers) {
    if (s.transport !== "http" || !s.url) continue;
    out[s.name] = {
      type: "http",
      url: s.url,
      headers: s.headers,
    };
  }
  return out;
}

export async function invokeAgent(
  deps: InvokeDeps,
  request: AgentRequest,
  signal: AbortSignal,
): Promise<InvokeResult> {
  const acc = initAccumulator();

  const iter = query({
    prompt: request.user_text,
    options: {
      // Only pass `resume` for threads with a prior successful turn — a
      // brand-new thread has no id the SDK would recognize yet.
      ...(request.session.is_new
        ? {}
        : { resume: request.session.session_id }),
      ...(deps.model ? { model: deps.model } : {}),
      systemPrompt: deps.systemPrompt,
      mcpServers: toSdkMcpServers(deps.mcpConfig),
      cwd: deps.cwd,
      // Load project-scoped skills from <cwd>/.claude/skills/. The startup
      // composition root symlinks <cwd>/.claude -> <repo>/.claude so skills
      // live in the repo while cwd stays an isolated scratch dir.
      settingSources: ["project"],
      allowedTools: [...ALLOWED_TOOLS],
      maxTurns: MAX_TURNS,
      // Pin to the running node binary so nvm/volta/asdf users don't hit
      // `spawn node ENOENT` — the SDK otherwise spawns bare "node" which
      // relies on PATH resolution in the child process.
      executable: process.execPath,
      // Surface the subprocess's stderr. Quiet on healthy runs; invaluable
      // when the CLI itself crashes ("No conversation found", missing
      // permissions, MCP handshake errors, etc.).
      stderr: (msg: string) => {
        process.stderr.write(`[claude-cli] ${msg}`);
      },
    },
  } as Parameters<typeof query>[0]);

  try {
    for await (const msg of iter) {
      if (signal.aborted) {
        const maybeReturn = (iter as AsyncIterator<unknown>).return;
        if (typeof maybeReturn === "function") {
          try {
            await maybeReturn.call(iter, undefined);
          } catch {
            // iterator cleanup is best-effort
          }
        }
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      // Inspect the message BEFORE applyMessage so we can emit debug traces
      // and detect tool_use batches for onProgress. Only look at shapes we
      // care about; anything else falls through untouched.
      const before = acc.tool_calls;
      const lastTool = traceMessage(msg, deps.logger);
      const hadTools = acc.tools !== undefined;
      applyMessage(acc, msg);
      // First system/init message: log what the SDK subprocess registered.
      // Makes "is Skill loaded on this turn?" a grep away in pm2 logs.
      if (!hadTools && acc.tools !== undefined) {
        deps.logger.info("agent subprocess ready", {
          tools: acc.tools,
          mcp_servers: acc.mcp_servers,
        });
      }
      if (request.onProgress && acc.tool_calls > before) {
        try {
          request.onProgress({
            tool_calls: acc.tool_calls,
            last_tool: lastTool,
          });
        } catch (cbErr) {
          deps.logger.debug("onProgress threw", {
            error_message:
              cbErr instanceof Error ? cbErr.message : String(cbErr),
          });
        }
      }
    }
  } catch (err) {
    if (signal.aborted) {
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    // If the accumulator captured a structured result_error before the
    // stream died, surface that instead of the generic subprocess exit.
    // Happens when the CLI emits `{subtype:"success", is_error:true,
    // result:"Invalid API key..."}` and then exits 1.
    if (acc.result_error) {
      throw new SdkResultError(
        acc.result_error.subtype,
        acc.result_error.errors,
      );
    }
    throw err;
  }

  if (acc.result_error) {
    throw new SdkResultError(acc.result_error.subtype, acc.result_error.errors);
  }

  return {
    text: acc.text,
    tool_calls: acc.tool_calls,
    sdk_session_id: acc.sdk_session_id,
    mcp_servers: acc.mcp_servers,
    tools: acc.tools,
    sdk_subtype: acc.sdk_subtype,
    sdk_num_turns: acc.sdk_num_turns,
    sdk_is_error: acc.sdk_is_error,
    sdk_duration_api_ms: acc.sdk_duration_api_ms,
    sdk_cost_usd: acc.sdk_cost_usd,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Emit per-message debug traces (option 3 of the heartbeat plan) and return
// the name of the last tool_use block in an assistant batch, if any, so the
// caller can forward it to onProgress. Kept separate from applyMessage so the
// accumulator stays free of IO.
function traceMessage(msg: unknown, logger: Logger): string | undefined {
  if (!isRecord(msg)) return undefined;
  const type = msg.type;

  if (type === "assistant") {
    const inner = msg.message;
    if (!isRecord(inner)) return undefined;
    const content = inner.content;
    if (!Array.isArray(content)) return undefined;
    let lastTool: string | undefined;
    let textLen = 0;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use") {
        const toolName =
          typeof block.name === "string" ? block.name : "<unknown>";
        const toolUseId =
          typeof block.id === "string" ? block.id : undefined;
        logger.debug("sdk tool_use", {
          tool_name: toolName,
          tool_use_id: toolUseId,
          input_preview: previewToolInput(block.input),
        });
        lastTool = toolName;
      } else if (block.type === "text" && typeof block.text === "string") {
        textLen += block.text.length;
      }
    }
    if (lastTool === undefined && textLen > 0) {
      logger.debug("sdk assistant text", { text_length: textLen });
    }
    return lastTool;
  }

  if (type === "result") {
    logger.debug("sdk result", {
      sdk_subtype: typeof msg.subtype === "string" ? msg.subtype : undefined,
      sdk_num_turns:
        typeof msg.num_turns === "number" ? msg.num_turns : undefined,
    });
  }
  return undefined;
}

// Give debug logs enough of the tool's input to identify what the model is
// doing without blowing out log size. For MCP SQL calls, `input.query`
// carries the statement — that's the field we actually need to see on a
// fanout-investigation turn. Fall back to a stringified dump for anything
// else. Capped at 500 chars so a giant JSON body can't dominate a log line.
function previewToolInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (isRecord(input) && typeof input.query === "string") {
    return input.query.slice(0, 500);
  }
  try {
    return JSON.stringify(input).slice(0, 500);
  } catch {
    return undefined;
  }
}
