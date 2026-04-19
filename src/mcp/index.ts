import type { McpConfig } from "../types/index.js";

export function loadMcpConfig(env: NodeJS.ProcessEnv): McpConfig {
  void env;
  return { servers: [] };
}
