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

    expect(() => loadSystemPrompt(path)).toThrow(
      /system prompt file not found.*does-not-exist\.md/,
    );
  });

  it("throws when the file exists but is empty or whitespace-only", () => {
    const path = join(dir, "empty.md");
    writeFileSync(path, "   \n\n", "utf8");

    expect(() => loadSystemPrompt(path)).toThrow(/empty/);
  });
});
