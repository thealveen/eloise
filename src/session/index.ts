import type { Logger, SessionResolver } from "../types/index.js";

export function createSessionResolver(deps: {
  dbPath: string;
  logger: Logger;
}): SessionResolver {
  void deps;
  return {
    async resolve() {
      throw new Error("not implemented: session");
    },
  };
}
