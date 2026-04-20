// Implements spec §10.5 Composition Root.
import "dotenv/config";
import { createLogger } from "./observability/index.js";
import { loadSystemPrompt } from "./prompt/index.js";
import { loadMcpConfig } from "./mcp/index.js";
import { createSessionResolver } from "./session/index.js";
import { createAgentRunner } from "./agent/index.js";
import { createSlackAdapter } from "./slack/index.js";
import type { LogLevel } from "./types/index.js";

async function main() {
  const logger = createLogger({ level: (process.env.LOG_LEVEL as LogLevel) ?? "info" });
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
    cwd: process.env.AGENT_WORKDIR ?? "/home/botuser/agent-workdir",
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
