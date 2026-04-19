import { describe, expect, it } from "vitest";
import { createLogger } from "./index.js";

describe("createLogger", () => {
  it("returns a logger with log/debug/info/warn/error methods", () => {
    const logger = createLogger({ level: "info" });
    for (const fn of ["log", "debug", "info", "warn", "error"] as const) {
      expect(typeof logger[fn]).toBe("function");
    }
  });
});
