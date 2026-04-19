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
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        acc.text += block.text;
      } else if (block.type === "tool_use") {
        acc.tool_calls += 1;
      }
    }
  }
}
