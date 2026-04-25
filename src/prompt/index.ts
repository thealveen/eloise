// Implements spec §7 System Prompt.
/**
 * System prompt loader.
 *
 * Reads the behavioral contract given to Claude on every turn from a markdown
 * file at the given path. Per spec §7, this is a static file loaded at startup
 * and reused for the lifetime of the process, so synchronous I/O is fine and
 * simpler than wiring async through the composition root.
 */

import { readFileSync } from "node:fs";
import type { SystemPrompt } from "../types/index.js";

/**
 * Loads the system prompt from disk.
 *
 * Throws with a clear message if the file is missing or empty. An empty-file
 * check is important because booting with a blank prompt would silently ship
 * a bot with no behavioral rules — the model would freelance on style,
 * formatting, and the K7 write-confirmation contract.
 *
 * Optional `appends` are loaded and concatenated after the base prompt, each
 * under its own scoped heading. Used to attach the DB schema reference so the
 * model doesn't need `list_tables` / `describe_table` introspection calls to
 * write queries.
 */
export type PromptAppend = { heading: string; path: string };

export function loadSystemPrompt(
  path: string,
  appends: PromptAppend[] = [],
): SystemPrompt {
  const base = readPromptFile(path);
  if (base.trim().length === 0) {
    throw new Error(`system prompt file is empty: ${path}`);
  }

  const parts: string[] = [base];
  for (const a of appends) {
    const body = readPromptFile(a.path);
    if (body.trim().length === 0) continue;
    parts.push(`\n---\n\n## ${a.heading}\n\n${body}`);
  }
  return parts.join("\n");
}

function readPromptFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(`system prompt file not found: ${path}`);
    }
    throw err;
  }
}
