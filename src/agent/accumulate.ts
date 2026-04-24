// Implements spec §5 Agent Runner.
//
// Accumulates text and tool-use counts from the Agent SDK's streamed messages.
//
// The SDK emits a tagged-union of message types. We care about three shapes:
//   - system init: carries the actual session_id the SDK is using
//   - assistant:   carries content blocks of type "text" and "tool_use"
//   - result:      final message, also carries session_id
// Anything else (user echoes, tool_result replays, stream events) is ignored.

export type Accumulator = {
  text: string;
  tool_calls: number;
  sdk_session_id?: string;
  // Populated from the `system` init message. Useful as a diagnostic when
  // the agent reports "I don't have MCP tooling" — that usually means the
  // supabase server's status here is `failed` or `needs-auth`, or no
  // `mcp__supabase__*` names appear in `tools`.
  mcp_servers?: { name: string; status: string }[];
  tools?: string[];
};

export function initAccumulator(): Accumulator {
  return { text: "", tool_calls: 0 };
}

type AnyRecord = Record<string, unknown>;

function isRecord(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null;
}

export function applyMessage(acc: Accumulator, msg: unknown): void {
  if (!isRecord(msg)) return;
  const type = msg.type;

  if (type === "system") {
    const sessionId = msg.session_id;
    if (typeof sessionId === "string") acc.sdk_session_id = sessionId;
    if (Array.isArray(msg.mcp_servers)) {
      acc.mcp_servers = msg.mcp_servers
        .filter(
          (s): s is { name: string; status: string } =>
            isRecord(s) &&
            typeof s.name === "string" &&
            typeof s.status === "string",
        )
        .map((s) => ({ name: s.name, status: s.status }));
    }
    if (Array.isArray(msg.tools)) {
      acc.tools = msg.tools.filter((t): t is string => typeof t === "string");
    }
    return;
  }

  if (type === "result") {
    const sessionId = msg.session_id;
    if (typeof sessionId === "string") acc.sdk_session_id = sessionId;
    return;
  }

  if (type === "assistant") {
    const inner = msg.message;
    if (!isRecord(inner)) return;
    const content = inner.content;
    if (!Array.isArray(content)) return;
    // Messages that include a tool_use block are think-act steps, not the
    // final synthesis. Any text in them is narration ("Let me check X"),
    // which we don't want in the Slack reply. Drop the narration AND reset
    // any previously-accumulated narration from earlier steps so only text
    // emitted after the last tool call survives.
    const hasToolUse = content.some(
      (b) => isRecord(b) && b.type === "tool_use",
    );
    if (hasToolUse) {
      acc.text = "";
      for (const block of content) {
        if (isRecord(block) && block.type === "tool_use") {
          acc.tool_calls += 1;
        }
      }
      return;
    }
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        acc.text += block.text;
      }
    }
  }
}
