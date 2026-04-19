import { describe, expect, it } from "vitest";
import { createSessionResolver } from "./index.js";
import { createLogger } from "../observability/index.js";

describe("createSessionResolver", () => {
  it("returns a resolver with a resolve function", () => {
    const resolver = createSessionResolver({
      dbPath: ":memory:",
      logger: createLogger({ level: "info" }),
    });
    expect(typeof resolver.resolve).toBe("function");
  });
});
