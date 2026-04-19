import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "./index.js";

describe("loadMcpConfig", () => {
  it("throws a clear error when SUPABASE_MCP_TOKEN is missing", () => {
    expect(() => loadMcpConfig({})).toThrow(/SUPABASE_MCP_TOKEN/);
  });

  it("throws when SUPABASE_MCP_TOKEN is an empty string", () => {
    expect(() => loadMcpConfig({ SUPABASE_MCP_TOKEN: "" })).toThrow(
      /SUPABASE_MCP_TOKEN/,
    );
  });

  it("returns a Supabase HTTP server with a Bearer header", () => {
    const cfg = loadMcpConfig({ SUPABASE_MCP_TOKEN: "sbp_test_abc" });
    expect(cfg).toEqual({
      servers: [
        {
          name: "supabase",
          transport: "http",
          url: "https://mcp.supabase.com/mcp",
          headers: { Authorization: "Bearer sbp_test_abc" },
        },
      ],
    });
  });

  it("scopes to a single project when SUPABASE_PROJECT_REF is set", () => {
    const cfg = loadMcpConfig({
      SUPABASE_MCP_TOKEN: "sbp_test_abc",
      SUPABASE_PROJECT_REF: "abcd1234",
    });
    expect(cfg.servers[0]?.url).toBe(
      "https://mcp.supabase.com/mcp?project_ref=abcd1234",
    );
  });

  it("url-encodes a project ref with special characters", () => {
    const cfg = loadMcpConfig({
      SUPABASE_MCP_TOKEN: "sbp_test_abc",
      SUPABASE_PROJECT_REF: "weird/ref",
    });
    expect(cfg.servers[0]?.url).toBe(
      "https://mcp.supabase.com/mcp?project_ref=weird%2Fref",
    );
  });
});
