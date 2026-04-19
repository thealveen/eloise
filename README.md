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
ecosystem.config.cjs
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

## Deployment

The bot runs as a single Node process under pm2 on an Ubuntu 24.04 VPS. Full first-time walkthrough (Slack app creation, Anthropic/Supabase credentials, Hetzner VPS provisioning, troubleshooting) is in `docs/DEPLOY.md`. Quick reference:

1. **Provision** — as root on a fresh VPS: `bash scripts/setup.sh <repo-url>`. Installs Node 20, pm2, creates `botuser`, clones the repo, runs `npm ci && npm run build && npm run init-db`.
2. **Configure** — as `botuser`: `cp .env.example .env`, fill in four secrets (`ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SUPABASE_MCP_TOKEN`), `chmod 600 .env`.
3. **Start** — `pm2 start ecosystem.config.cjs`, then `pm2 save`. To survive reboots, run `pm2 startup systemd -u botuser --hp /home/botuser` (as root) and paste the command it prints.
4. **Update** — `git pull && npm ci && npm run build && pm2 reload slack-bot`.
5. **Logs** — `pm2 logs slack-bot`. SQLite at `data/sessions.db`.

See `docs/DEPLOY.md` for everything — if it's your first time setting up a Slack bot, start there.

## Status

All core components (Slack adapter, session resolver, agent runner, MCP config, system prompt, observability) are implemented. Phase 1 scaffolding notes are preserved below for historical context.

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
