// Implements spec §10.5 Composition Root.
import "dotenv/config";
import { lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "./observability/index.js";
import { loadSystemPrompt } from "./prompt/index.js";
import { loadMcpConfig } from "./mcp/index.js";
import { createSessionResolver } from "./session/index.js";
import { createAgentRunner } from "./agent/index.js";
import { createSlackAdapter } from "./slack/index.js";
import type { LogLevel, Logger } from "./types/index.js";

async function main() {
  const logger = createLogger({ level: (process.env.LOG_LEVEL as LogLevel) ?? "info" });
  const systemPrompt = loadSystemPrompt("./prompts/system.md");
  const mcpConfig = loadMcpConfig(process.env);
  const agentCwd = process.env.AGENT_WORKDIR ?? "/home/botuser/agent-workdir";
  // SDK resolves .claude/skills/ from cwd. Our cwd is an isolated scratch
  // dir, so we symlink to the repo's .claude/ at startup. Idempotent.
  ensureSkillsSymlink({ agentCwd, repoRoot: process.cwd(), logger });
  const sessionResolver = createSessionResolver({
    dbPath: "./data/sessions.db",
    logger,
  });
  const agentRunner = createAgentRunner({
    systemPrompt,
    mcpConfig,
    timeoutMs: 120_000,
    cwd: agentCwd,
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    model: process.env.AGENT_MODEL,
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

function ensureSkillsSymlink(deps: {
  agentCwd: string;
  repoRoot: string;
  logger: Logger;
}): void {
  const target = resolve(deps.repoRoot, ".claude");
  const link = join(deps.agentCwd, ".claude");
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(link);
  } catch {
    // doesn't exist — create it
    try {
      symlinkSync(target, link, "dir");
      deps.logger.info("skills symlink created", { link, target });
    } catch (err) {
      deps.logger.warn("skills symlink create failed", {
        link,
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (existing.isSymbolicLink()) {
    const current = readlinkSync(link);
    if (resolve(deps.agentCwd, current) === target) return;
    deps.logger.warn("skills symlink points elsewhere — leaving it alone", {
      link,
      current,
      expected: target,
    });
    return;
  }
  deps.logger.warn("skills path exists and is not a symlink — skipping", {
    link,
    expected: target,
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
