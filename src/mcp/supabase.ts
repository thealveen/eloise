// Implements spec §6 MCP Configuration.
//
// Supabase MCP authentication — findings (2026-04-19)
//
// Source: https://supabase.com/docs/guides/getting-started/mcp
//
// The hosted endpoint https://mcp.supabase.com/mcp supports two auth modes:
//   - OAuth 2.1 (browser-based, default) — not viable in a headless VPS
//   - Bearer-token with a Personal Access Token (PAT) — the path we use
//
// The PAT is minted at https://supabase.com/dashboard/account/tokens and passed
// as an `Authorization: Bearer <token>` header.
//
// Spec §8 names the env var SUPABASE_MCP_TOKEN (not the Supabase-docs name
// SUPABASE_ACCESS_TOKEN). We honor the spec name so Agent E's .env template
// and Agent 0's composition root stay in sync.
//
// Project scoping is done via a `?project_ref=<ref>` query param (optional).
// If unset, the MCP server operates across all projects the token can see.

import type { McpServerConfig } from "../types/index.js";

const SUPABASE_MCP_URL = "https://mcp.supabase.com/mcp";

export function buildSupabaseServer(env: NodeJS.ProcessEnv): McpServerConfig {
  const token = env.SUPABASE_MCP_TOKEN;
  if (!token || token.length === 0) {
    throw new Error("missing env var: SUPABASE_MCP_TOKEN");
  }
  const projectRef = env.SUPABASE_PROJECT_REF;
  const url = projectRef
    ? `${SUPABASE_MCP_URL}?project_ref=${encodeURIComponent(projectRef)}`
    : SUPABASE_MCP_URL;
  return {
    name: "supabase",
    transport: "http",
    url,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}
