// Implements spec §5 Agent Runner.
//
// Agent SDK invocation — findings & design notes (2026-04-19).
//
// Open item 1 (spec §11): session semantics.
// Source: https://code.claude.com/docs/en/agent-sdk/sessions
//
//   - query() returns an AsyncGenerator of SDKMessage events.
//   - `resume: "<uuid>"` resumes an on-disk session if present; otherwise the
//     SDK silently starts a fresh session. It does not error on unknown ids.
//   - The SDK mints its own session id for brand-new sessions; there is no
//     documented option to force a caller-supplied UUID onto a new session.
//     The actual session id is reported in the `system` init message and the
//     final `result` message.
//
// Consequence: SessionResolver generates a UUID up-front and stores it in
// SQLite, but on a brand-new conversation the SDK may end up using a
// different id. The public AgentResult contract (types/agent.ts) doesn't
// carry the SDK's id, so we can't propagate it back to SessionResolver in
// v1. We detect the drift here, log a warn, and proceed — subsequent turns
// keep passing the SQLite-stored id, so the drift stays stable (not
// growing). A clean fix requires widening AgentResponse + SessionResolver;
// deferred to v2.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRequest, McpConfig } from "../types/index.js";
import { applyMessage, initAccumulator } from "./accumulate.js";

export type InvokeDeps = {
  systemPrompt: string;
  mcpConfig: McpConfig;
  cwd: string;
};

export type InvokeResult = {
  text: string;
  tool_calls: number;
  sdk_session_id?: string;
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
      resume: request.session.session_id,
      systemPrompt: deps.systemPrompt,
      mcpServers: toSdkMcpServers(deps.mcpConfig),
      cwd: deps.cwd,
      allowedTools: [...ALLOWED_TOOLS],
      maxTurns: MAX_TURNS,
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
  };
}
