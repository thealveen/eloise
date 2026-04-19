import { describe, expect, it } from "vitest";
import { createAgentRunner } from "./index.js";
import { createLogger } from "../observability/index.js";

describe("createAgentRunner", () => {
  it("returns a runner with a run function", () => {
    const runner = createAgentRunner({
      systemPrompt: "",
      mcpConfig: { servers: [] },
      timeoutMs: 1000,
      cwd: "/tmp",
      anthropicApiKey: "test",
      logger: createLogger({ level: "info" }),
    });
    expect(typeof runner.run).toBe("function");
  });
});
