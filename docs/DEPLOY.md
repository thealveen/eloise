# Deploying the Slack bot

First-time walkthrough. Assumes you have never shipped a Slack bot before. If you've done this a hundred times, the `Deployment` section of the top-level `README.md` is a terser version of the same steps.

## What you'll build

A Slack bot, running as a single Node process on a small Linux VPS, that listens for `@mentions` in any channel it's invited to, routes the message through the Claude Agent SDK (with a Supabase MCP server attached), and posts the reply back in the same thread. No Docker, no CI, no domain name — all traffic is outbound WebSocket (Socket Mode).

## Step 1 — Gather credentials

You need four things before you touch the server: a Slack app with two tokens, an Anthropic API key, and a Supabase Personal Access Token. Collect them first so step 4 is painless.

### 1a. Slack app

1. Go to <https://api.slack.com/apps> and sign in.
2. Click **Create New App** → **From an app manifest**.
3. Pick your workspace, then paste the manifest below and click **Next → Create**:

   ```yaml
   display_information:
     name: Slack Bot
     description: Answers @mentions and continues threads via the Claude Agent SDK.
   features:
     bot_user:
       display_name: Slack Bot
       always_online: true
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - chat:write
         - reactions:write
         - channels:history
         - groups:history
         - im:history
         - mpim:history
   settings:
     event_subscriptions:
       bot_events:
         - app_mention
         - message.channels
         - message.groups
         - message.im
         - message.mpim
     interactivity:
       is_enabled: false
     org_deploy_enabled: false
     socket_mode_enabled: true
     token_rotation_enabled: false
   ```

   The `message.*` subscriptions + `*:history` scopes are what let the bot continue a thread without being re-@mentioned on every reply. The handler only *acts* on explicit mentions and thread replies in active sessions, but with these scopes the bot *can see* every message in any channel it's been added to. Don't add it to sensitive channels you wouldn't want it reading.

4. In the left sidebar, click **Install App** → **Install to Workspace** → **Allow**. Copy the **Bot User OAuth Token** (starts with `xoxb-`). This is `SLACK_BOT_TOKEN`.
5. Click **Basic Information** → scroll to **App-Level Tokens** → **Generate Token and Scopes**. Give it any name; add scope **`connections:write`**; click **Generate**. Copy the token (starts with `xapp-`). This is `SLACK_APP_TOKEN`.

Tokens are only shown once. Paste them into a password manager or a scratch note you'll paste from later.

### 1a.i. Updating an existing install

If you already installed the bot with an older manifest (or your bot only replies when @-mentioned), re-grant scopes:

1. Open your app at <https://api.slack.com/apps> → pick your app.
2. Sidebar → **App Manifest** → replace the YAML with the block above → **Save Changes**.
3. Slack detects the new scopes and shows a yellow **Reinstall your app** banner at the top. Click it → **Allow**.
4. Your `SLACK_BOT_TOKEN` does not change; no `.env` edit required.
5. No restart needed — the bot's Socket Mode connection picks up the newly-granted events immediately. (Restart if you want, it's harmless.)

### 1b. Anthropic API key

1. Go to <https://console.anthropic.com/settings/keys>.
2. Click **Create Key**, name it, click **Create**.
3. Copy the key (starts with `sk-ant-`). This is `ANTHROPIC_API_KEY`.

Make sure billing is set up on the account — calls will fail immediately otherwise. Treat the key like a password: store it in a secret manager, rotate if it ever lands in a log.

### 1c. Supabase Personal Access Token

1. Go to <https://supabase.com/dashboard/account/tokens>.
2. Click **Generate new token**, name it, click **Generate token**.
3. Copy the token. This is `SUPABASE_MCP_TOKEN`.

If you want the bot limited to one Supabase project, note its project ref — that's the string in the URL at `https://supabase.com/dashboard/project/<ref>`. You'll put it in `SUPABASE_PROJECT_REF` later. Leaving it unset means the MCP server can see every project the token has access to.

### 1d. Hetzner VPS

1. Sign up at <https://console.hetzner.cloud>. Add a payment method.
2. Create a **Project**, then **Add Server**:
   - Location: any (pick one close to you).
   - Image: **Ubuntu 24.04**.
   - Type: **CX22** (2 vCPU / 4 GB RAM, ~€4/mo — plenty for this workload).
   - SSH keys: paste your public key (`~/.ssh/id_ed25519.pub` or similar). Password auth is flaky and not recommended.
3. Click **Create & Buy now**. Record the public IPv4 address.

## Step 2 — Provision the VPS

From your laptop, upload the setup script:

```sh
scp scripts/setup.sh root@<vps-ip>:/root/
```

SSH in and run it (pass the clone URL for this repo):

```sh
ssh root@<vps-ip>
bash /root/setup.sh https://github.com/<your-org>/<repo>.git
```

What it does (in order), with each step printing a `===> step N: ...` banner:

1. installs Node 20 LTS via NodeSource
2. installs `git`, `sqlite3`, `build-essential`
3. installs `pm2` globally
4. creates an unprivileged `botuser` (no sudo, password login locked)
5. clones (or updates) the repo to `/home/botuser/slack-bot`
6. creates `/home/botuser/agent-workdir` and `/home/botuser/slack-bot/data/`
7. symlinks `agent-workdir/.claude` → `slack-bot/.claude` so the Agent SDK can find `.claude/skills/` from its cwd
8. runs `npm ci`, `npm run build`, `npm run init-db` as `botuser`

Typical runtime: 2–4 minutes on a fresh box; faster on a re-run. The script is idempotent — re-run it any time.

## Step 3 — Create `.env`

Drop into the bot user's shell and configure secrets:

```sh
sudo -u botuser -i
cd ~/slack-bot
cp .env.example .env
nano .env            # or $EDITOR — vi, vim, whatever you have
```

Fill the four required values (`ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SUPABASE_MCP_TOKEN`). `NODE_ENV` and `LOG_LEVEL` already have sensible defaults. `SUPABASE_PROJECT_REF` is optional — uncomment and fill it only if you want to pin the MCP server to one project.

Save and lock the file:

```sh
chmod 600 .env
```

## Step 4 — Start the bot

Still as `botuser`, in `~/slack-bot`:

```sh
pm2 start ecosystem.config.cjs
```

Check it's alive:

```sh
pm2 status           # "slack-bot" row should say "online"
pm2 logs slack-bot   # look for "bot started"
```

## Step 5 — Survive reboots

Tell pm2 to re-launch the bot on boot.

As `botuser`:

```sh
pm2 save
```

Then, as root (exit back out or open a second SSH session):

```sh
pm2 startup systemd -u botuser --hp /home/botuser
```

That prints an `env ... systemctl ...` command. Copy it, paste it, run it. That installs the systemd unit that starts pm2 on boot as `botuser`, which in turn starts the bot.

## Step 6 — Smoke test

In Slack, invite the bot to a channel and mention it:

```
/invite @<your-bot-name>
@<your-bot-name> hello
```

Expected: within a second or two the bot adds a 👀 reaction to your message; within ~30 seconds, it posts a reply in the same thread and swaps the reaction to ✅.

If you delete the original @mention, the bot cleans up after itself: it deletes every reply it posted in that thread and drops the session row, so the thread disappears entirely instead of leaving orphan bot messages. No manifest or scope changes are needed — `message_deleted` rides on the existing `message.*` subscriptions and `chat:write` covers `chat.delete` on bot-authored messages.

If nothing happens: `pm2 logs slack-bot` and check the troubleshooting table below.

## Deploying updates

Four commands, as `botuser`, in `~/slack-bot`:

```sh
git pull
npm ci
npm run build
pm2 reload slack-bot
```

If `.env.example` gained a new variable, `pm2 logs` will show `missing env var: X`. Add it to `.env`, then `pm2 restart slack-bot` (reload won't re-read env on its own).

## Updating env vars

Edit `~/slack-bot/.env` (as `botuser`), then:

```sh
sudo -u botuser pm2 restart slack-bot
```

Use `restart`, not `reload`. `reload` keeps the old env vars in memory; `restart` kills the process and picks up the new `.env` via our `dotenv/config` import. Verify with `pm2 logs slack-bot` — you should see `bot started` again within a second.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `missing env var: <NAME>` in logs | `.env` incomplete, or typo, or not in `~/slack-bot/` | add/fix the var, `pm2 restart slack-bot` |
| Bot is `online` but never replies to `@mentions` | not invited to the channel, or app-level token lacks `connections:write` | `/invite @bot` in Slack; regenerate the xapp-token with the right scope |
| `pm2 status` → `errored` shortly after start | usually malformed `.env` (smart quotes from a chat app, trailing space, missing value) | re-open `.env`, fix, `pm2 restart` |
| `npm ci` fails with "gyp ERR!" / native-build errors | `build-essential` missing | re-run `bash setup.sh <repo-url>` as root |
| After reboot, `pm2 list` is empty | `pm2 save` or `pm2 startup` never ran | step 5 |
| Constant restarts / "max_memory_restart" | runaway memory | `pm2 describe slack-bot` for restart count and last logs; file an issue |

## Inspecting state

- SQLite sessions: `sqlite3 ~/slack-bot/data/sessions.db ".schema"` then `SELECT * FROM thread_sessions LIMIT 5;`
- Agent SDK JSONL history: `ls ~/.claude/projects/` (these are per-session conversation transcripts the SDK writes; destroyed if the VPS is destroyed — that's accepted per K17).
- pm2 logs: live via `pm2 logs slack-bot`; on disk at `~/.pm2/logs/slack-bot-out.log` and `~/.pm2/logs/slack-bot-error.log`.

## Rotating secrets or tearing down

Rotate a single secret: edit `~/slack-bot/.env`, `pm2 restart slack-bot`.

Revoke a leaked credential at its source:
- Slack tokens → <https://api.slack.com/apps> → your app → **OAuth & Permissions** (revoke install) or **Basic Information → App-Level Tokens**.
- Anthropic key → <https://console.anthropic.com/settings/keys> → Delete.
- Supabase PAT → <https://supabase.com/dashboard/account/tokens> → Revoke.

Tear down the bot without destroying the VPS:

```sh
sudo -u botuser pm2 delete slack-bot
sudo -u botuser pm2 save
```

Or just destroy the VPS in the Hetzner console.
