import type { McpConfig } from "../types/index.js";
import { buildSupabaseServer } from "./supabase.js";

export function loadMcpConfig(env: NodeJS.ProcessEnv): McpConfig {
  return {
    servers: [buildSupabaseServer(env)],
  };
}
