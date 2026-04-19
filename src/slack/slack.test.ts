import { describe, expect, it } from "vitest";
import { createSlackAdapter } from "./index.js";
import { createLogger } from "../observability/index.js";
import { createSessionResolver } from "../session/index.js";
import { createAgentRunner } from "../agent/index.js";

describe("createSlackAdapter", () => {
  it("returns an adapter with start and stop functions", () => {
    const logger = createLogger({ level: "info" });
    const adapter = createSlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      sessionResolver: createSessionResolver({ dbPath: ":memory:", logger }),
      agentRunner: createAgentRunner({
        systemPrompt: "",
        mcpConfig: { servers: [] },
        timeoutMs: 1,
        cwd: "/tmp",
        anthropicApiKey: "test",
        logger,
      }),
      logger,
    });
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.stop).toBe("function");
  });
});
