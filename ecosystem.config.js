module.exports = {
  apps: [
    {
      name: "slack-bot",
      script: "dist/index.js",
      autorestart: true,
      max_memory_restart: "500M",
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
