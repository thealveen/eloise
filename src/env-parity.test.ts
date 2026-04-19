// Implements spec §8 Deployment — guards .env.example against drift.
//
// Walks src/, collects every env-var name referenced as `process.env.X`,
// `env.X`, or `requireEnv("X")`, and asserts each one appears in
// .env.example (either as `X=...` or commented `# X=...`).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = HERE; // vitest runs with cwd=repo-root, but import.meta.url is stable
const ENV_EXAMPLE = join(HERE, "..", ".env.example");

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const s = statSync(path);
    if (s.isDirectory()) {
      walkTsFiles(path, acc);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      acc.push(path);
    }
  }
  return acc;
}

function collectReferencedEnvVars(): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /\bprocess\.env\.([A-Z_][A-Z0-9_]+)/g,
    /\benv\.([A-Z_][A-Z0-9_]+)/g,
    /\brequireEnv\(\s*["']([A-Z_][A-Z0-9_]+)["']\s*\)/g,
  ];
  for (const file of walkTsFiles(SRC_DIR)) {
    const src = readFileSync(file, "utf8");
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        names.add(m[1]);
      }
    }
  }
  return names;
}

function parseEnvExampleKeys(): Set<string> {
  const keys = new Set<string>();
  const text = readFileSync(ENV_EXAMPLE, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // Accept both "NAME=..." (required) and "# NAME=..." (optional/commented).
    const m = line.match(/^#?\s*([A-Z_][A-Z0-9_]+)\s*=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

describe(".env.example parity with src/ references", () => {
  it("every env var referenced in src/ is documented in .env.example", () => {
    const referenced = collectReferencedEnvVars();
    const documented = parseEnvExampleKeys();
    const missing = [...referenced].filter((n) => !documented.has(n)).sort();
    expect(missing, `missing from .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  it("finds at least the known required vars (smoke — proves the walker works)", () => {
    const referenced = collectReferencedEnvVars();
    for (const name of [
      "ANTHROPIC_API_KEY",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SUPABASE_MCP_TOKEN",
      "LOG_LEVEL",
    ]) {
      expect(referenced.has(name), `expected src/ to reference ${name}`).toBe(true);
    }
  });
});
