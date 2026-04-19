# Slack Bot

A Slack bot that responds to `@mentions` by running the user's message through the Claude Agent SDK, with MCP integrations (Supabase today). See `slack-bot-spec.md` for the full design.

## Layout

```
src/
  types/         # frozen cross-component contracts (spec §10.3)
  slack/         # Slack Adapter (spec §3)
  session/       # Session Resolver (spec §4)
  agent/         # Agent Runner (spec §5)
  mcp/           # MCP Configuration (spec §6)
  prompt/        # System Prompt (spec §7)
  observability/ # Logger (spec §9)
  index.ts       # composition root (spec §10.5)
prompts/system.md
scripts/init-db.cjs
data/            # runtime artifacts, gitignored except .gitkeep
ecosystem.config.js
```

Each component directory has exactly one public entry (`index.ts`). Other components import only from the entry module or from `src/types/`. See spec §10.2.

## Setup

```sh
npm install
cp .env.example .env   # fill in values
npm run init-db        # creates data/sessions.db
npm run build
npm start
```

## Development

- `npm run dev` — watch mode via `tsx`
- `npm test` — vitest
- `npm run format` — prettier

## Phase 1 status

This is a scaffold. Component factories exist but their methods throw `not implemented: <component>` at runtime. Downstream agents (A–E) fill them in next. Build and tests pass today; `npm start` starts the process but crashes as soon as Slack input is expected — that's intentional.

## Open decisions (Agent 0)

Documented here so downstream agents and future readers can see what was decided during scaffolding.

- **`better-sqlite3`** chosen over `node:sqlite` for its sync API — simpler call sites in the Session Resolver. Native binding; `npm install` needs a C toolchain (Xcode CLT on macOS; `build-essential` on Ubuntu, per spec §8).
- **`createLogger` returns a no-op stub** (not a throwing one). Spec §Phase 1 rule for stubs was "throw on any method call except for `loadMcpConfig` / `loadSystemPrompt`". Logger is a cross-cutting dep — every other factory takes one, and their tests need to call it. A throwing logger would block downstream agents from writing unit tests for their own components. No-op is the smallest viable placeholder. Agent D owns the real implementation.
- **`scripts/init-db.cjs`** (not `.js`). Package is `"type": "module"`, so a plain `.js` would be parsed as ESM and break `require("better-sqlite3")`. CJS script is simpler than dual-mode.
- **Tests excluded from `tsc`** (`exclude: ["**/*.test.ts"]`). Otherwise `tsc` emits compiled tests into `dist/`, polluting the production artifact. Vitest runs them directly from `src/`.
- **`.gitignore` uses `.claude/`**, not `~/.claude/`. Tilde isn't valid gitignore syntax. On the VPS `~/.claude/` lives outside the repo root anyway; this pattern only guards against local-dev accidental commits.
- **Skipped ESLint.** Prettier only. Spec says "skip eslint unless trivial" — no trivially-correct config exists for this stack yet.

## Reference

- Spec: `slack-bot-spec.md`
- Agent 0 Phase 1 rules: `.context/attachments/pasted_text_2026-04-19_21-51-46.txt` (local only; not in git)
