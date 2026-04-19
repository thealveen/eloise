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
 */
export function loadSystemPrompt(path: string): SystemPrompt {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    // Distinguish "not found" (fixable by the operator) from other I/O
    // failures (permissions, etc.) so the error message is actionable.
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(`system prompt file not found: ${path}`);
    }
    throw err;
  }

  if (contents.trim().length === 0) {
    throw new Error(`system prompt file is empty: ${path}`);
  }

  return contents;
}
