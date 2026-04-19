import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "./index.js";

describe("loadMcpConfig", () => {
  it("returns an empty servers list in the stub", () => {
    expect(loadMcpConfig({})).toEqual({ servers: [] });
  });
});
