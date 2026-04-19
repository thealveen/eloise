#!/usr/bin/env bash
# Implements spec §8 Deployment — one-time VPS bootstrap.
#
# Usage (as root on a fresh Ubuntu 24.04 host):
#   bash setup.sh <repo-url>
#
# Idempotent: safe to re-run. Each step skips its work if already done.
set -euo pipefail

BOT_USER="botuser"
BOT_HOME="/home/${BOT_USER}"
REPO_DIR="${BOT_HOME}/slack-bot"
WORK_DIR="${BOT_HOME}/agent-workdir"

usage() {
  cat >&2 <<EOF
Usage: bash setup.sh <repo-url>

Provisions a fresh Ubuntu 24.04 Hetzner VPS for the Slack bot:
  - Node 20 LTS, git, sqlite3, build-essential
  - pm2 (global)
  - user '${BOT_USER}' with home ${BOT_HOME}
  - repo cloned to ${REPO_DIR}
  - ${WORK_DIR} (Agent SDK cwd) and ${REPO_DIR}/data/ (SQLite)
  - npm ci, npm run build, npm run init-db (as ${BOT_USER})

Must run as root.
EOF
  exit 1
}

step() {
  printf '\n===> step %s: %s\n' "$1" "$2"
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "error: setup.sh must be run as root" >&2
  usage
fi

if [[ $# -ne 1 ]]; then
  usage
fi

REPO_URL="$1"

step 1 "install Node 20 LTS"
if command -v node >/dev/null 2>&1 && node -v | grep -qE '^v20\.'; then
  echo "node $(node -v) already installed, skipping"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

step 2 "install system packages (git, sqlite3, build-essential)"
apt-get update -y
apt-get install -y git sqlite3 build-essential

step 3 "install pm2 (global)"
if command -v pm2 >/dev/null 2>&1; then
  echo "pm2 $(pm2 -v) already installed, skipping"
else
  npm install -g pm2
fi

step 4 "create user '${BOT_USER}'"
if id -u "${BOT_USER}" >/dev/null 2>&1; then
  echo "user ${BOT_USER} already exists, skipping"
else
  useradd -m -s /bin/bash -d "${BOT_HOME}" "${BOT_USER}"
  passwd -l "${BOT_USER}" >/dev/null
  echo "created user ${BOT_USER} (password login locked, no sudo)"
fi

step 5 "clone or update repo at ${REPO_DIR}"
if [[ -d "${REPO_DIR}/.git" ]]; then
  echo "repo already present, fetching latest on current branch"
  sudo -u "${BOT_USER}" -H git -C "${REPO_DIR}" fetch --all --prune
  sudo -u "${BOT_USER}" -H git -C "${REPO_DIR}" pull --ff-only
else
  sudo -u "${BOT_USER}" -H git clone "${REPO_URL}" "${REPO_DIR}"
fi

step 6 "create runtime directories"
install -d -o "${BOT_USER}" -g "${BOT_USER}" -m 750 "${WORK_DIR}" "${REPO_DIR}/data"

step 7 "install deps, build, init db (as ${BOT_USER})"
sudo -u "${BOT_USER}" -H bash -lc "cd '${REPO_DIR}' && npm ci && npm run build && npm run init-db"

cat <<EOF

===> setup complete.

Next steps (run these as the bot user):

  sudo -u ${BOT_USER} -i
  cd ~/slack-bot
  cp .env.example .env
  \$EDITOR .env              # fill ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SUPABASE_MCP_TOKEN
  chmod 600 .env
  pm2 start ecosystem.config.cjs
  pm2 save

Then, back as root, enable pm2 on reboot:

  pm2 startup systemd -u ${BOT_USER} --hp ${BOT_HOME}
  # copy-paste and run the command it prints.

Verify:

  sudo -u ${BOT_USER} pm2 logs slack-bot     # should show "bot started"

See docs/DEPLOY.md for the full first-time walkthrough.
EOF
