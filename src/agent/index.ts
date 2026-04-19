import type { AgentRunner, Logger, McpConfig, SystemPrompt } from "../types/index.js";

export function createAgentRunner(deps: {
  systemPrompt: SystemPrompt;
  mcpConfig: McpConfig;
  timeoutMs: number;
  cwd: string;
  anthropicApiKey: string;
  logger: Logger;
}): AgentRunner {
  void deps;
  return {
    async run() {
      throw new Error("not implemented: agent");
    },
  };
}
