import { readFileSync } from "node:fs";
import type { SystemPrompt } from "../types/index.js";

export function loadSystemPrompt(path: string): SystemPrompt {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
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
  if (contents.trim().length === 0) {
    throw new Error(`system prompt file is empty: ${path}`);
  }
  return contents;
}
