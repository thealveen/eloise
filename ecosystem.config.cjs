// Implements spec §8 Deployment — pm2 process config.
//
// Logs go to pm2's default location (~/.pm2/logs/slack-bot-{out,error}.log).
// Env vars are loaded by src/index.ts via `dotenv/config`; do NOT set them
// here or they'll mask values from .env.
module.exports = {
  apps: [
    {
      name: "slack-bot",
      script: "dist/index.js",
      cwd: "/home/botuser/slack-bot",
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "500M",
      time: true,
    },
  ],
};
