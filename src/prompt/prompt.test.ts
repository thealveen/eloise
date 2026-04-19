import { describe, expect, it } from "vitest";
import { loadSystemPrompt } from "./index.js";

describe("loadSystemPrompt", () => {
  it("returns an empty string in the stub", () => {
    expect(loadSystemPrompt("./prompts/system.md")).toBe("");
  });
});
