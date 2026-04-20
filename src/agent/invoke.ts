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
import type { AgentRequest, McpConfig } from "../types/index.js";
import { applyMessage, initAccumulator } from "./accumulate.js";

export type InvokeDeps = {
  systemPrompt: string;
  mcpConfig: McpConfig;
  cwd: string;
  model?: string;
};

export type InvokeResult = {
  text: string;
  tool_calls: number;
  sdk_session_id?: string;
  mcp_servers?: { name: string; status: string }[];
  tools?: string[];
};

// Spec §5: MCP tools + filesystem primitives. The `mcp__<server>` prefix is
// the SDK's convention for MCP tool namespacing. We pin to the supabase
// server by name; the exact wildcard expansion (prefix match) is handled by
// the SDK.
const ALLOWED_TOOLS = [
  "mcp__supabase",
  "Read",
  "Write",
  "Edit",
  "Bash",
] as const;

const MAX_TURNS = 20;

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
      applyMessage(acc, msg);
    }
  } catch (err) {
    if (signal.aborted) {
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    throw err;
  }

  return {
    text: acc.text,
    tool_calls: acc.tool_calls,
    sdk_session_id: acc.sdk_session_id,
    mcp_servers: acc.mcp_servers,
    tools: acc.tools,
  };
}
