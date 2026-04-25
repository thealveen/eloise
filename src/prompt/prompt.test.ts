/**
 * Tests for loadSystemPrompt.
 *
 * Uses a temp directory per test to exercise the real filesystem path
 * — no mocks. The loader is called at boot so its failure modes matter:
 * missing file and empty file both need to throw rather than silently
 * returning nothing.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSystemPrompt } from "./index.js";

describe("loadSystemPrompt", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prompt-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the contents of an existing file", () => {
    const path = join(dir, "system.md");
    const contents = "You are a team assistant.\n\nBe terse.\n";
    writeFileSync(path, contents, "utf8");

    expect(loadSystemPrompt(path)).toBe(contents);
  });

  it("throws a clear error when the file does not exist", () => {
    const path = join(dir, "does-not-exist.md");

    // The path must appear in the message so operators can fix it without
    // digging through stack traces.
    expect(() => loadSystemPrompt(path)).toThrow(
      /system prompt file not found.*does-not-exist\.md/,
    );
  });

  it("throws when the file exists but is empty or whitespace-only", () => {
    // Guards against silently booting with a blank prompt — the model would
    // freelance on style, formatting, and the K7 write-confirmation rule.
    const path = join(dir, "empty.md");
    writeFileSync(path, "   \n\n", "utf8");

    expect(() => loadSystemPrompt(path)).toThrow(/empty/);
  });

  it("appends extra files under scoped headings", () => {
    const basePath = join(dir, "system.md");
    const schemaPath = join(dir, "schema.md");
    writeFileSync(basePath, "Be terse.", "utf8");
    writeFileSync(schemaPath, "table foo(id uuid)", "utf8");

    const out = loadSystemPrompt(basePath, [
      { heading: "Postgres schema", path: schemaPath },
    ]);

    expect(out).toContain("Be terse.");
    expect(out).toContain("## Postgres schema");
    expect(out).toContain("table foo(id uuid)");
  });
});
