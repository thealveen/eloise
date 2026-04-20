# Running the bot locally

Running the bot on your laptop against **real** Slack, Anthropic, and Supabase credentials — no pm2, no VPS. For mocked unit tests run `npm test`. For production deployment see `docs/DEPLOY.md`.

## Why run it locally

- **Tighter feedback loop than deploying.** Ctrl+C and edit beats `git pull && pm2 reload`.
- **Confirms your credentials actually work** before you ship them to a VPS. If Socket Mode won't handshake here, it won't handshake there either.
- **Reproduces prod Socket Mode behavior** that the mocked E2E test in `src/e2e.test.ts` can't cover — real Slack events, real Anthropic calls, real MCP traffic.

## Prerequisites

- **Node 20** — check with `node -v`.
- **Native build toolchain** for `better-sqlite3`:
  - macOS: `xcode-select --install` (once per machine).
  - Linux: `sudo apt install -y build-essential sqlite3 git`.
- **The four secrets from `docs/DEPLOY.md` Step 1** — Slack bot token (`xoxb-…`), Slack app-level token (`xapp-…`), Anthropic API key (`sk-ant-…`), Supabase PAT. If you've never made a Slack app before, go do §1a–§1c of that doc and come back — the steps are identical for local. If you've run an older version of this bot before, also do §1a.i ("Updating an existing install") so thread replies without `@mention` work.

## Setup

```sh
git clone <repo>
cd slack-bot
npm ci
cp .env.example .env
```

Edit `.env`:
- Fill the four required secrets.
- **Uncomment `AGENT_WORKDIR=./agent-workdir`** (or point it at a `/tmp` path). This is required locally — the default is the VPS path `/home/botuser/agent-workdir` which doesn't exist on your laptop. Without it, the bot crashes on the first `@mention` with `ENOENT`.
- Optional: set `LOG_LEVEL=debug` for noisier output while you're iterating.

Create the workdir and initialize the session DB:

```sh
mkdir -p ./agent-workdir
npm run init-db
```

## Run

Two options:

- `npm start` — runs `npm run build` then `node dist/index.js`. Matches prod exactly.
- `npm run dev` — `tsx watch src/index.ts`. Auto-restarts on source changes. Faster iteration but Slack reconnects on every edit, so don't edit mid-conversation.

Expected stdout: NDJSON log lines, ending with `{"level":"info","msg":"bot started"}`. If you see `missing env var: X`, the secret isn't loaded — check `.env` is in the repo root and has no trailing whitespace on the value.

## Smoke test

In Slack, from a test channel:

```
/invite @<your-bot-name>
@<your-bot-name> hello
```

Expect within ~30 s: 👀 reaction → reply in-thread → ✅ reaction. Watch your terminal for the corresponding log lines.

## Stop + reset

- **Stop the bot**: Ctrl+C.
- **Wipe session state** (forget all threads): `rm data/sessions.db && npm run init-db`.
- **Wipe agent scratch**: `rm -rf ./agent-workdir/*`. Agent SDK transcript history is separate — it lives in `~/.claude/projects/`; see `docs/DEPLOY.md` § "Inspecting state" for what's in there.

## Gotchas

- **Don't run this laptop bot while the VPS bot is also running, if both use the same Slack app.** Socket Mode allows only one active connection per app-level token; the second one will flap and events get delivered nondeterministically. Make a second Slack app if you need both.
- **`npm ci` fails with `gyp ERR!` / native-build errors** → toolchain is missing. Reinstall Xcode CLT (macOS) or `build-essential` (Linux) and retry.
- **Bot connects but never replies to `@mentions`** → same root causes as the VPS troubleshooting table; see `docs/DEPLOY.md` § "Troubleshooting". Most common: not invited to the channel, or the app-level token is missing the `connections:write` scope.
- **`ENOENT: no such file or directory ... agent-workdir`** → `AGENT_WORKDIR` unset (or pointing at a path you forgot to create). Set it in `.env`, `mkdir -p` the directory, restart.

## When you're ready to deploy

See `docs/DEPLOY.md` for running the bot under pm2 on a VPS.
