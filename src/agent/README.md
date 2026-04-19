# src/agent — Agent Runner

Owns the Claude Agent SDK invocation for one Slack turn. The Slack Adapter hands this component an `AgentRequest`; it returns an `AgentResult` — a tagged union of `{ ok: true, response }` or `{ ok: false, error }`. This module **never throws**; the Slack Adapter dispatches on `error.kind` to pick the user-facing message (per spec §§5, 9).

Public surface: `createAgentRunner` from `./index.ts` only. Everything else is internal — other components must not import from subfiles here.

## Files

- **`index.ts`** — factory. Orchestrates timeout → invoke → accumulate, maps errors to `AgentError`, sanitizes log output, emits the one-line-per-turn log entry (spec §9).
- **`invoke.ts`** — wraps `query()` from `@anthropic-ai/claude-agent-sdk`. Translates our `McpConfig` (array, `transport`) into the SDK's `mcpServers` record shape (`type: "http"`). Runs the `for await` stream loop, honors an incoming `AbortSignal`. SDK types are confined to this file and `accumulate.ts`; they never leak to the public surface.
- **`accumulate.ts`** — pure reducer over SDK messages. Concatenates assistant `text` blocks, counts `tool_use` blocks (not included in the response text), captures the SDK-minted `session_id` from `system`/`result` events.
- **`timeout.ts`** — `withTimeout(ms, run)` uses both `AbortController` and `Promise.race`, so the runner is guaranteed to resolve by `ms + ε` even if the SDK ignores the abort signal. Throws an exported `TimeoutError`.
- **`agent.test.ts`** — covers the success path, timeout, each error-kind mapping, and a no-secrets-in-logs assertion. SDK is mocked via `vi.mock`; no network.

## Contract

Input (from `src/types/agent.ts`):
```
AgentRequest = { session, user_text, meta }
```

Output:
```
AgentResult = { ok: true, response: { text, duration_ms, tool_calls } }
            | { ok: false, error: AgentError }

AgentError  = { kind: "timeout" }
            | { kind: "rate_limit" }
            | { kind: "api_error"; message }
            | { kind: "mcp_error"; message }
            | { kind: "unknown"; message }
```

## Invariants

- **Never throws.** All exceptions are caught and mapped to an `AgentError` kind.
- **Hard 120s timeout** (`timeoutMs` in deps, 120_000 from the composition root per K13). A running SDK iterator may leak briefly after abort; accepted per spec.
- **No secrets in logs.** `index.ts#makeSanitizer` strips the Anthropic key, MCP bearer tokens, and `sk-ant-…` / `xox…` / `Bearer …` patterns from any `error_message` before it reaches the logger. System prompt and MCP headers are never passed to the logger at all.
- **SDK types are private.** Only `invoke.ts` and `accumulate.ts` import from `@anthropic-ai/claude-agent-sdk`. The public result carries plain fields.

## Open-item resolutions

**Session semantics** (spec §11 item 1). The SDK silently starts a fresh session when `resume` names an id not on disk, and mints its own UUID for that new session rather than honoring the caller-supplied one. We pass `resume: session.session_id` unconditionally, capture the SDK's actual id from the stream, and log a `warn` on drift. Propagating the drift back to `SessionResolver` would require widening `AgentResponse` and the resolver interface (both outside Agent C's scope) — deferred to v2. See the comment block at the top of `invoke.ts`.

## Related

- MCP server config: `src/mcp/` (sibling component, same agent).
- Types contract: `src/types/agent.ts`.
- Logger contract: `src/types/observability.ts`.
