# Slack Bot — Design Spec

**Status:** Draft v1
**Target:** Single-VPS Slack bot using Claude Agent SDK, with MCP integrations, deployed on Hetzner.

---

## 1. Overview

A Slack bot that responds to `@mentions` by running the user's message through the Claude Agent SDK. The agent has access to MCP tools (initially Supabase, later Google Sheets). Each Slack thread is its own persistent conversation; the bot remembers prior turns within a thread indefinitely.

The bot runs as a single long-lived Node process on a Hetzner Ubuntu VPS. It connects to Slack via Socket Mode (no public URL required). Conversation history is stored on the VPS filesystem via the Agent SDK's built-in session mechanism. A small SQLite file maps Slack thread identifiers to SDK session IDs.

### Architecture diagram

```
┌────────────┐         ┌───────────────────────────────────────────┐
│            │◄────────┤  Hetzner VPS (Ubuntu 24.04)               │
│   Slack    │  socket │  ┌────────────────────────────────────┐   │
│            │ ────────►  │  Node process (pm2-managed)        │   │
└────────────┘         │  │                                    │   │
                       │  │  ┌──────────────┐                  │   │
                       │  │  │ Slack        │                  │   │
                       │  │  │ adapter      │                  │   │
                       │  │  │ (Bolt)       │                  │   │
                       │  │  └──────┬───────┘                  │   │
                       │  │         │                          │   │
                       │  │  ┌──────▼───────┐  ┌──────────┐    │   │
                       │  │  │ Session      │  │ SQLite   │    │   │
                       │  │  │ resolver     │◄─┤ mapping  │    │   │
                       │  │  └──────┬───────┘  └──────────┘    │   │
                       │  │         │                          │   │
                       │  │  ┌──────▼───────┐                  │   │
                       │  │  │ Agent runner │                  │   │
                       │  │  │ (Agent SDK)  │                  │   │
                       │  │  └──────┬───────┘                  │   │
                       │  │         │                          │   │
                       │  │         ├─► ~/.claude/projects/    │   │
                       │  │         │   (JSONL history)        │   │
                       │  │         │                          │   │
                       │  │         ├─► Supabase MCP ─────┐    │   │
                       │  │         └─► (future) Sheets   │    │   │
                       │  └──────────────────────────────┼─┘   │   │
                       └─────────────────────────────────┼─────┘   
                                                         │         
                                                  ┌──────▼──────┐  
                                                  │  Supabase   │  
                                                  │  (product)  │  
                                                  └─────────────┘  
```

### Component list

1. **Slack adapter** — receives events, posts responses, manages reactions
2. **Session resolver** — maps Slack events to SDK session IDs
3. **Agent runner** — invokes the Agent SDK with the right config
4. **MCP configuration** — declares which MCP servers to connect and how
5. **System prompt & rules** — the behavioral spec given to Claude
6. **Deployment** — VPS setup, process management, secrets

Cross-cutting concerns (observability, failure handling) are covered in section 9.

---

## 2. Key Decisions

These are locked choices that downstream sections reference rather than redecide.

| # | Decision | Rationale |
|---|----------|-----------|
| K1 | **Language: Node.js** (v20 LTS) | Matches Bolt and Agent SDK first-class support; team preference. |
| K2 | **Slack transport: Socket Mode** | No public URL, no TLS, no webhook signature dance. Simpler for single-VPS. |
| K3 | **Conversation unit = Slack thread** | `thread_ts` is the session key in channels. In DMs, same rule: top-level messages each create their own session; threaded replies continue their thread's session. |
| K4 | **Trigger = @mention only** | First message in a thread must @mention the bot. Subsequent messages in that thread continue the conversation without needing another mention. |
| K5 | **History storage: Agent SDK sessions on local filesystem** | JSONL files under `~/.claude/projects/`. No external DB for conversation history in v1. |
| K6 | **Thread-to-session mapping: SQLite** | Single file on the VPS, accessed by the Node process. Source of truth for which Slack thread maps to which SDK session ID. |
| K7 | **MCPs v1: Supabase only (read-write, confirm-before-write)** | Single Supabase project. Write operations require Claude to restate the change and wait for user confirmation in the thread. |
| K8 | **No access control** | Anyone in the workspace who can @mention the bot can use it. |
| K9 | **No commands, slash commands, or magic keywords in v1** | Deferred. Includes no `/reset`, no `/help`. |
| K10 | **Response style: short but complete** | Slack culture is terse; system prompt enforces. |
| K11 | **Progress indicator: 🤔 reaction** | Added on receipt, removed when reply is posted. |
| K12 | **Error UX: ❌ reaction + in-thread apology message** | Server-side logs get the full error. Slack sees a friendly message. |
| K13 | **Agent call timeout: 120 seconds** | Hard ceiling. Timeout produces the same UX as any other error. |
| K14 | **Session lifetime: indefinite** | No expiry, no cleanup in v1. |
| K15 | **Deployment: git pull + pm2 restart over SSH** | No CI/CD in v1. |
| K16 | **Secrets: single `.env` file, chmod 600** | No secret manager in v1. |
| K17 | **No backups** (explicit choice) | Accepted risk. JSONL history is lost if the VPS is destroyed. |

### Component interface contract

Every component section below declares, at the top:
- **Consumes** — what this component is given
- **Produces** — what this component emits
- **Depends on** — which other components or external systems
- **Owns** — what state or config lives here

This is the contract that makes parallel work possible. Changes to a component's *consumes*/*produces* require updating dependents explicitly.

---

## 3. Component: Slack Adapter

**Consumes:** Slack events over Socket Mode (bot token + app token from env).
**Produces:** Normalized event objects handed to the Session Resolver; posts text responses and reactions back to Slack.
**Depends on:** Slack workspace configuration; Bolt SDK; Session Resolver; Agent Runner.
**Owns:** Slack SDK connection, event filtering, response formatting, reaction management.

### Responsibilities

1. **Connect to Slack via Socket Mode** using `SLACK_BOT_TOKEN` (`xoxb-...`) and `SLACK_APP_TOKEN` (`xapp-...`).
2. **Subscribe to events:**
   - `app_mention` — @mentions in channels
   - `message.im` — direct messages (including threaded replies in DMs)
   - `message.channels` filtered to thread replies where the bot has an active session for that thread (for K4's "subsequent messages don't need mention" rule)
3. **Filter events:**
   - Ignore messages where `bot_id` is set (skip own messages and other bots)
   - For non-mention messages in channels: only process if the Session Resolver reports an existing session for the thread
4. **Normalize events** into a common shape for downstream:
   ```
   {
     source: "channel" | "dm",
     channel_id: string,
     thread_ts: string,       // for top-level messages, equals message ts
     user_id: string,
     text: string,            // with leading @bot mention stripped
     message_ts: string
   }
   ```
5. **Add 🤔 reaction** to the triggering message immediately on receipt.
6. **Post response** in-thread (`thread_ts` set) via `chat.postMessage`, using Slack mrkdwn format.
7. **Remove 🤔 reaction**, or on failure, add ❌ and post the error message.

### Formatting rules

- Claude outputs Slack mrkdwn (system prompt enforces: `*bold*`, `_italic_`, `` `code` ``, triple-backtick code blocks, no tables).
- Long responses are posted as a single message (no auto-splitting in v1).
- Responses always post in-thread using the `thread_ts` of the triggering thread.

### Open interface point

The Slack Adapter passes the normalized event to the Session Resolver and awaits a session ID. It then passes `{ sessionId, text, meta }` to the Agent Runner. It does not invoke the Agent SDK directly.

---

## 4. Component: Session Resolver

**Consumes:** Normalized Slack events from the Slack Adapter.
**Produces:** An Agent SDK session ID; a boolean `isNew` indicating whether this is a fresh conversation.
**Depends on:** SQLite database file (`./data/sessions.db`).
**Owns:** The `thread_sessions` table and the logic that maps Slack threads to SDK session IDs.

### Storage schema

One SQLite table:

```
thread_sessions
  slack_key       TEXT PRIMARY KEY    -- "{channel_id}:{thread_ts}"
  session_id      TEXT NOT NULL       -- Agent SDK session ID (UUID)
  created_at      INTEGER NOT NULL    -- unix epoch seconds
  last_used_at    INTEGER NOT NULL    -- unix epoch seconds
```

### Resolution logic

Given a normalized event with `channel_id` and `thread_ts`:

1. Compute `slack_key = "{channel_id}:{thread_ts}"`.
2. Look up `slack_key` in `thread_sessions`.
3. If found: return `{ sessionId: row.session_id, isNew: false }`. Update `last_used_at`.
4. If not found: generate a new session ID (UUID v4), insert the row, return `{ sessionId, isNew: true }`.

### Slack key construction rules (derived from K3)

- **Channel top-level @mention**: `thread_ts` in the normalized event equals the message's own `ts`. Key is `{channel}:{message_ts}`.
- **Channel thread reply**: `thread_ts` is the parent's `ts`. Key is `{channel}:{parent_ts}`.
- **DM top-level**: same as channel top-level. Each new top-level DM message gets a fresh session. (Explicit consequence of K3, strict rule.)
- **DM thread reply**: same as channel thread reply.

### Does not own

- Session *content* (that's the Agent SDK's JSONL files).
- Cleanup of stale sessions (K14: none in v1).
- Authorization (K8: none).

---

## 5. Component: Agent Runner

**Consumes:** `{ sessionId, isNew, text, meta }` from the Slack Adapter.
**Produces:** A final assistant text response (string), or an error.
**Depends on:** Agent SDK (`@anthropic-ai/claude-agent-sdk`); MCP Configuration; System Prompt; `ANTHROPIC_API_KEY` from env.
**Owns:** The agent invocation loop, timeout enforcement, response accumulation.

### Invocation shape

For each message, invoke the Agent SDK's `query` function with:

- **prompt**: the user text (mention stripped)
- **options:**
  - `resume: sessionId` (always — SDK handles new-session creation transparently when the JSONL doesn't exist yet, but see note below)
  - `systemPrompt`: loaded from the System Prompt component
  - `mcpServers`: from the MCP Configuration component
  - `cwd`: a fixed working directory on the VPS (`/home/botuser/agent-workdir`) so all sessions land in a consistent `~/.claude/projects/` subdirectory
  - `allowedTools`: the MCP tools + `Read`, `Write`, `Edit`, `Bash` (if the agent needs to manipulate scratch files). Specific list pinned in the MCP Configuration section.
  - `maxTurns`: 20 (safety ceiling on tool-use loop length)

**Note on `isNew`:** If `isNew: true`, the Agent Runner skips `resume` and lets the SDK create a fresh session, then records the assigned session ID back via the Session Resolver. If the SDK doesn't support this flow directly, the Runner creates the session file manually or uses a session-creation API — this is an implementation detail to be resolved during build. *(Open item: confirm exact SDK mechanics for session initialization vs. resume.)*

### Timeout

Wrap the entire `for await` loop in a 120-second timeout (K13). On timeout:
- Abort the SDK iterator (use the SDK's `AbortController` option if available)
- Throw a timeout error that propagates to the Slack Adapter

### Response accumulation

The SDK streams message objects. The Agent Runner:
- Accumulates `assistant` text blocks into a final string
- Ignores intermediate `tool_use` / `tool_result` events for the response (they're internal to the agent loop)
- Returns the full accumulated text when the iterator completes normally

### Error surface

Any exception from the SDK call (timeout, API error, MCP failure) propagates unchanged to the Slack Adapter, which translates it per K12.

---

## 6. Component: MCP Configuration

**Consumes:** Environment variables for MCP credentials.
**Produces:** An `mcpServers` config object passed to the Agent Runner.
**Depends on:** `.env` file; remote MCP endpoints.
**Owns:** MCP server URLs, auth headers, tool allowlists per server.

### v1 MCPs

**Supabase MCP** (read-write, single project):

```
supabase: {
  type: "http",
  url: "https://mcp.supabase.com/mcp",
  headers: {
    Authorization: "Bearer ${SUPABASE_MCP_TOKEN}"
  }
}
```

*(Exact auth scheme to verify against current Supabase MCP docs at build time.)*

### Tool allowlist

Claude is permitted to call any tool the Supabase MCP exposes, with the K7 rule enforced by the system prompt (confirm before writes). The `allowedTools` array in the Agent Runner options includes Supabase tools + filesystem primitives for scratch work.

### Deferred MCPs

Google Sheets MCP will be added in a future version. Not in v1.

### Credentials

All MCP credentials live in the `.env` file. The MCP Configuration module reads from `process.env` at process startup and refuses to start if required vars are missing (fail-fast).

---

## 7. Component: System Prompt & Rules

**Consumes:** Nothing at runtime. A static markdown file loaded at startup.
**Produces:** The `systemPrompt` string passed to every Agent SDK call.
**Depends on:** A file at `./prompts/system.md`.
**Owns:** All behavioral rules given to Claude.

### Prompt contents (in order)

1. **Identity**: "You are a team assistant in Slack with access to Supabase via MCP."
2. **Response style (K10)**: terse, complete, no preamble, no filler, direct answers.
3. **Formatting**: Slack mrkdwn only. `*bold*` not `**bold**`. No tables. Code blocks OK.
4. **Write-action rule (K7)**: before any Supabase write, update, delete, or migration, restate the exact change in one or two sentences and wait for explicit confirmation ("yes", "confirm", "go ahead"). Reads never require confirmation.
5. **Read defaults**: limit read queries to 50 rows unless the user asks for more. Prefer explicit column selection over `SELECT *`.
6. **Ambiguity**: if intent is unclear, ask exactly one clarifying question. Do not fire off speculative tool calls.
7. **Error honesty**: if a tool fails, report what failed and suggest a next step. Don't fabricate success.

### Update process

System prompt changes are code changes — edit the file, commit, deploy. No hot reload in v1.

---

## 8. Component: Deployment

**Consumes:** A Hetzner VPS with Ubuntu 24.04, SSH access.
**Produces:** A running bot process.
**Depends on:** Node 20 LTS, pm2, git, SQLite.
**Owns:** Setup scripts, pm2 config, `.env` layout.

### One-time VPS setup

A shell script (`setup.sh`) in the repo performs:

1. Install Node 20 LTS via NodeSource
2. Install system packages: `git`, `sqlite3`, `build-essential`
3. Install pm2 globally: `npm install -g pm2`
4. Create a dedicated user `botuser` (non-root, no sudo) with home at `/home/botuser`
5. Clone the repo to `/home/botuser/slack-bot`
6. Create `/home/botuser/agent-workdir` (the `cwd` for the Agent SDK, per section 5)
7. Create `/home/botuser/slack-bot/data/` (for the SQLite file)
8. Run `npm ci` to install Node deps
9. Initialize the SQLite schema via a small Node script (`scripts/init-db.cjs`)
10. Print instructions for creating `.env`

### `.env` contents

```
ANTHROPIC_API_KEY=sk-ant-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SUPABASE_MCP_TOKEN=...
NODE_ENV=production
LOG_LEVEL=info
```

Permissions: `chmod 600 .env`, owned by `botuser`.

### Running

- **Start**: `pm2 start ecosystem.config.cjs` from the repo root (as `botuser`)
- **Logs**: `pm2 logs slack-bot`
- **Restart**: `pm2 restart slack-bot`
- **Boot persistence**: `pm2 startup` + `pm2 save` once

### Deploy workflow (manual)

1. SSH to VPS as `botuser`
2. `cd ~/slack-bot && git pull`
3. `npm ci` if `package.json` changed
4. `pm2 restart slack-bot`

### Filesystem layout on VPS

```
/home/botuser/
├── slack-bot/              # git repo
│   ├── src/                # source
│   ├── prompts/system.md
│   ├── scripts/init-db.js
│   ├── data/sessions.db    # SQLite
│   ├── .env                # secrets
│   ├── ecosystem.config.cjs # pm2 config
│   └── ...
├── agent-workdir/          # cwd for Agent SDK; where ~/.claude/ lives implicitly
└── .claude/
    └── projects/           # JSONL session files, auto-created by SDK
```

---

## 9. Cross-cutting: Observability & Failure Modes

### Logging

- **Destination**: stdout (captured by pm2, viewable via `pm2 logs` and `journalctl -u pm2-botuser`)
- **Format**: single-line JSON, one event per Slack turn
- **Fields**: `timestamp`, `level`, `slack_key`, `session_id`, `user_id`, `text_preview` (first 80 chars), `tool_calls` (count), `duration_ms`, `status` (ok/error/timeout), `error_message` (if any)
- **Level**: controlled by `LOG_LEVEL` env var, default `info`

### Per-turn lifecycle and logging

Every triggering event produces exactly one log line on completion, regardless of outcome:

- Received → log `received` at debug
- Agent completes → log `ok` with duration and tool-call count
- Agent errors → log `error` with sanitized error message
- Agent times out (K13) → log `timeout`

### Failure mode matrix

| Failure | User sees | Log entry | Recovery |
|---------|-----------|-----------|----------|
| Slack socket disconnect | Nothing (Bolt auto-reconnects) | `warn` on disconnect, `info` on reconnect | Automatic |
| Missing env var at startup | Bot doesn't start | `fatal` to stdout | Fix `.env`, restart |
| Agent SDK error | ❌ reaction + "Something went wrong" in thread | `error` with message | User retries |
| Agent SDK timeout (120s) | ❌ reaction + "Took too long, try again" | `timeout` | User retries |
| MCP failure during tool call | Claude sees the tool error and either retries or reports it as part of its response | Captured in SDK logs | Depends on Claude's handling |
| SQLite unavailable | ❌ reaction + generic error | `error` | Manual investigation |
| Anthropic API rate limit | ❌ + "Rate limited, try again shortly" | `error` with rate-limit flag | Wait |
| Disk full (JSONL writes fail) | ❌ + generic error | `error` | Manual investigation |

### Out of scope for v1

- Metrics (no Prometheus, no dashboards)
- Distributed tracing
- Alerting (no Pagerduty, no Slack alert channel)
- Log shipping / aggregation

---

## 10. Repo Layout & Interface Contracts

This section defines the physical code layout and the typed interfaces that separate components. These exist to make parallel work safe: if every agent honors the types in `src/types/` and never reaches into another component's internals, the pieces plug together at integration time without conflict.

### 10.1 Directory layout

```
slack-bot/
├── src/
│   ├── index.ts                # composition root — wires components, starts app
│   │
│   ├── types/                  # shared types; the contract surface
│   │   ├── events.ts
│   │   ├── session.ts
│   │   ├── agent.ts
│   │   ├── mcp.ts
│   │   ├── prompt.ts
│   │   ├── observability.ts
│   │   └── index.ts            # barrel export
│   │
│   ├── slack/                  # Component: Slack Adapter (§3)
│   │   ├── index.ts            # public entry: createSlackAdapter()
│   │   ├── bolt-client.ts      # internal
│   │   ├── normalize.ts        # internal
│   │   ├── format.ts           # internal
│   │   ├── reactions.ts        # internal
│   │   └── slack.test.ts
│   │
│   ├── session/                # Component: Session Resolver (§4)
│   │   ├── index.ts            # public entry: createSessionResolver()
│   │   ├── sqlite.ts           # internal
│   │   ├── resolver.ts         # internal
│   │   └── session.test.ts
│   │
│   ├── agent/                  # Component: Agent Runner (§5)
│   │   ├── index.ts            # public entry: createAgentRunner()
│   │   ├── invoke.ts           # internal
│   │   ├── timeout.ts          # internal
│   │   ├── accumulate.ts       # internal
│   │   └── agent.test.ts
│   │
│   ├── mcp/                    # Component: MCP Configuration (§6)
│   │   ├── index.ts            # public entry: loadMcpConfig()
│   │   ├── supabase.ts         # internal
│   │   └── mcp.test.ts
│   │
│   ├── prompt/                 # Component: System Prompt (§7)
│   │   ├── index.ts            # public entry: loadSystemPrompt()
│   │   └── prompt.test.ts
│   │
│   └── observability/          # Cross-cutting (§9)
│       ├── index.ts            # public entry: createLogger()
│       └── log.ts              # internal
│
├── prompts/
│   └── system.md               # the actual system prompt text
│
├── scripts/
│   ├── init-db.cjs             # SQLite schema bootstrap (CommonJS — package is ESM)
│   └── setup.sh                # VPS one-time setup
│
├── data/                       # runtime artifacts (gitignored)
│   └── .gitkeep
│
├── ecosystem.config.cjs         # pm2 config
├── .env.example                # committed template
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

### 10.2 Rules

1. **Each component directory has exactly one public entry: `index.ts`.** All other files in that folder are internal implementation.
2. **Other components import only from `./slack`, `./session`, `./agent`, etc. — never `./slack/normalize`.**
3. **`src/types/` is the only cross-component import target besides entry modules.** Types are the contract; implementation is private.
4. **`src/index.ts` is the only file that knows about every component.** Composition lives here and nowhere else.
5. **Tests live next to code** (`foo.test.ts` next to `foo/index.ts`). Ownership stays obvious.
6. **Runtime artifacts are gitignored**: `data/` (except `data/.gitkeep`, so the directory exists post-clone), `.env`, `node_modules/`, `dist/`, and any local `.claude/` contents. (On the VPS, `~/.claude/` lives outside the repo root and isn't subject to `.gitignore` at all — the pattern in the repo just prevents local-dev accidental commits.)

### 10.3 Interface contracts (lives in `src/types/`)

#### `types/events.ts`

```ts
export type NormalizedEvent = {
  source: "channel" | "dm";
  channel_id: string;
  thread_ts: string;        // for top-level messages, equals message_ts
  message_ts: string;
  user_id: string;
  text: string;             // mention stripped, trimmed
};
```

Produced by the Slack Adapter. Consumed by Session Resolver and (indirectly) Agent Runner.

#### `types/session.ts`

```ts
import type { NormalizedEvent } from "./events";

export type SessionHandle = {
  session_id: string;       // UUID v4
  is_new: boolean;          // true if just created this turn
  slack_key: string;        // "{channel_id}:{thread_ts}"
};

export interface SessionResolver {
  resolve(event: NormalizedEvent): Promise<SessionHandle>;
}
```

Implemented by `src/session/index.ts`. Consumed by the Slack Adapter.

#### `types/agent.ts`

```ts
import type { SessionHandle } from "./session";

export type AgentRequest = {
  session: SessionHandle;
  user_text: string;
  meta: {
    user_id: string;
    slack_key: string;
  };
};

export type AgentResponse = {
  text: string;
  duration_ms: number;
  tool_calls: number;
};

export type AgentError =
  | { kind: "timeout" }
  | { kind: "rate_limit" }
  | { kind: "api_error"; message: string }
  | { kind: "mcp_error"; message: string }
  | { kind: "unknown"; message: string };

export type AgentResult =
  | { ok: true; response: AgentResponse }
  | { ok: false; error: AgentError };

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>;
}
```

The tagged `AgentError` union is load-bearing: the Slack Adapter selects user-facing messages by `kind` (K12, K13). Error strings are for logs, not dispatch.

#### `types/mcp.ts`

```ts
export type McpServerConfig = {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
};

export type McpConfig = {
  servers: McpServerConfig[];
};
```

Produced once at startup by `src/mcp/index.ts`. Consumed by the Agent Runner, passed through to the SDK.

#### `types/prompt.ts`

```ts
export type SystemPrompt = string;

export interface PromptLoader {
  load(): SystemPrompt;
}
```

#### `types/observability.ts`

```ts
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type LogEvent = {
  level: LogLevel;
  message: string;
  slack_key?: string;
  session_id?: string;
  user_id?: string;
  duration_ms?: number;
  tool_calls?: number;
  status?: "ok" | "error" | "timeout";
  error_message?: string;
  [key: string]: unknown;
};

export interface Logger {
  log(event: LogEvent): void;
  debug(msg: string, fields?: Partial<LogEvent>): void;
  info(msg: string, fields?: Partial<LogEvent>): void;
  warn(msg: string, fields?: Partial<LogEvent>): void;
  error(msg: string, fields?: Partial<LogEvent>): void;
}
```

Every component takes a `Logger` in its factory. This is how the per-turn log line (§9) gets assembled — each component contributes fields.

### 10.4 Component factory signatures

Each component's `index.ts` exports a single factory. These signatures are frozen by this spec:

```ts
// src/slack/index.ts
export function createSlackAdapter(deps: {
  botToken: string;
  appToken: string;
  sessionResolver: SessionResolver;
  agentRunner: AgentRunner;
  logger: Logger;
}): { start(): Promise<void>; stop(): Promise<void> };

// src/session/index.ts
export function createSessionResolver(deps: {
  dbPath: string;
  logger: Logger;
}): SessionResolver;

// src/agent/index.ts
export function createAgentRunner(deps: {
  systemPrompt: SystemPrompt;
  mcpConfig: McpConfig;
  timeoutMs: number;
  cwd: string;
  anthropicApiKey: string;
  logger: Logger;
}): AgentRunner;

// src/mcp/index.ts
export function loadMcpConfig(env: NodeJS.ProcessEnv): McpConfig;

// src/prompt/index.ts
export function loadSystemPrompt(path: string): SystemPrompt;

// src/observability/index.ts
export function createLogger(opts: { level: LogLevel }): Logger;
```

### 10.5 Composition root

`src/index.ts` (the only file allowed to import from every component):

```ts
import { createLogger } from "./observability";
import { loadSystemPrompt } from "./prompt";
import { loadMcpConfig } from "./mcp";
import { createSessionResolver } from "./session";
import { createAgentRunner } from "./agent";
import { createSlackAdapter } from "./slack";

async function main() {
  const logger = createLogger({ level: (process.env.LOG_LEVEL as any) ?? "info" });
  const systemPrompt = loadSystemPrompt("./prompts/system.md");
  const mcpConfig = loadMcpConfig(process.env);
  const sessionResolver = createSessionResolver({
    dbPath: "./data/sessions.db",
    logger,
  });
  const agentRunner = createAgentRunner({
    systemPrompt,
    mcpConfig,
    timeoutMs: 120_000,
    cwd: "/home/botuser/agent-workdir",
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    logger,
  });
  const slackAdapter = createSlackAdapter({
    botToken: requireEnv("SLACK_BOT_TOKEN"),
    appToken: requireEnv("SLACK_APP_TOKEN"),
    sessionResolver,
    agentRunner,
    logger,
  });
  await slackAdapter.start();
  logger.info("bot started");
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var: ${name}`);
  return v;
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
```

### 10.6 Parallelization map

Once Agent 0 has written `src/types/`, stubbed `src/index.ts`, and created empty component directories with mock `index.ts` exports matching the factory signatures, these agents can proceed in parallel:

| Agent | Scope | Primary files |
|-------|-------|---------------|
| A | Slack Adapter | `src/slack/*` |
| B | Session Resolver | `src/session/*`, `scripts/init-db.js` |
| C | Agent Runner + MCP Config | `src/agent/*`, `src/mcp/*` |
| D | Prompt + Observability | `src/prompt/*`, `prompts/system.md`, `src/observability/*` |
| E | Deployment | `scripts/setup.sh`, `ecosystem.config.cjs`, `.env.example`, `README.md` |

**Ownership note**: Agent 0 creates the **baseline** `.env.example` and `ecosystem.config.cjs` during Phase 1 scaffolding so the repo installs/builds. Agent E **refines** both during deployment work. Agent E must not change the env-var list without coordinating — new vars affect every component's config loading.

**Handoff convention**: Agents A–E each push a branch `agent-<letter>` off the Phase 1 scaffold commit (e.g., `agent-a`, `agent-b`). Agent 0 merges them in Phase 2 in this order: **D → B → C → A → E**. Rationale: Logger/prompt first (every other component depends on them), then stateless components (session, agent+mcp), then Slack (wires everyone), then deployment docs. Tests should stay runnable at each merge step.

Integration is performed by Agent 0 (or a synthesizer pass) after components land: replace mock entries with real imports in the composition root, run end-to-end tests, fix integration bugs.

---

## 11. Appendix

### Open questions to resolve at build time

1. **Agent SDK session initialization semantics.** Does `resume: <new-uuid>` create a session on the fly, or does the SDK require an explicit create-then-resume flow? Section 5 leaves this open. First task during implementation.
2. **Supabase MCP exact auth mechanism.** Section 6 assumes a Bearer token; verify against current Supabase MCP docs. May require OAuth flow instead of static token.
3. **Socket Mode reconnect behavior under sustained network loss.** Bolt handles reconnection but edge cases (long outages, token refresh) not explored in spec.
4. **Reaction race conditions.** If two messages arrive in the same thread concurrently, both will add 🤔. Removing it cleanly requires tracking which is which. Low-priority; Slack's reaction API is idempotent per emoji per message.

### Deferred to v2+

- Google Sheets MCP
- Slash commands (/reset, /help)
- Streaming responses (edit-as-typed)
- Context compaction triggers (currently relying on SDK defaults)
- Access control / allowed channels list
- Backups of JSONL + SQLite
- CI/CD deployment
- Secret manager (replace `.env`)
- Multi-VPS / load balancing (would require replacing K5 and K6 with shared storage)
- Metrics and alerting

### Glossary

- **Thread**: a Slack thread, identified by `thread_ts`. In this spec, synonymous with "conversation."
- **Session**: an Agent SDK session, identified by a UUID. One-to-one with a Slack thread.
- **Slack key**: the composite `{channel_id}:{thread_ts}` string used as the primary key in SQLite.
- **MCP**: Model Context Protocol — the standard Anthropic uses for external tool integrations.
- **Socket Mode**: Slack's outbound-websocket transport for bots, as opposed to webhook delivery.
