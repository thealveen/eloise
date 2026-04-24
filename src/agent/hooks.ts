// PostToolUse hook for Supabase MCP tools.
//
// The Supabase MCP server wraps tool results in a four-layer envelope that
// provides no information value once the content is already isolated as a
// tool_result block:
//
//   1. MCP content array:  [{ type: "text", text: "<stringified JSON>" }]
//   2. .[0].text parses to { "result": "<untrusted-data-UUID>…</untrusted-data-UUID>" }
//   3. the "result" string wraps the actual payload in <untrusted-data-UUID> tags
//   4. the payload itself is what the model actually wants
//
// For MCP tools the SDK runs PostToolUse hooks BEFORE the persistence
// decision, so stripping the wrap here lets a smaller payload stay inline,
// and when persistence does fire the file on disk is clean JSON instead of
// a nested envelope the model has to unwrap with shell scripts.

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

const SUPABASE_PREFIX = "mcp__supabase__";
const UNTRUSTED_TAG_RE = /<\/?untrusted-data-[^>]+>/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Pure transform — exported for unit tests. Returns the unwrapped payload
// string, or undefined if the response doesn't match the Supabase envelope
// shape. Never throws.
export function unwrapSupabaseText(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const content = response.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (!isRecord(first) || first.type !== "text") return undefined;
  const outerText = first.text;
  if (typeof outerText !== "string") return undefined;

  let inner: unknown;
  try {
    inner = JSON.parse(outerText);
  } catch {
    return undefined;
  }
  if (!isRecord(inner)) return undefined;
  const resultStr = inner.result;
  if (typeof resultStr !== "string") return undefined;

  return resultStr.replace(UNTRUSTED_TAG_RE, "").trim();
}

export const unwrapSupabaseEnvelope: HookCallback = async (input) => {
  if (input.hook_event_name !== "PostToolUse") return {};
  if (!input.tool_name.startsWith(SUPABASE_PREFIX)) return {};

  const unwrapped = unwrapSupabaseText(input.tool_response);
  if (unwrapped === undefined) return {};

  const original = input.tool_response as Record<string, unknown>;
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedMCPToolOutput: {
        ...original,
        content: [{ type: "text", text: unwrapped }],
      },
    },
  };
};
