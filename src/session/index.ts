// Implements spec §4 Session Resolver.
import type { Logger, SessionResolver } from "../types/index.js";
import { openSessionDb } from "./sqlite.js";
import { createResolverFromDb } from "./resolver.js";

export function createSessionResolver(deps: {
  dbPath: string;
  logger: Logger;
}): SessionResolver {
  const sdb = openSessionDb(deps.dbPath);
  return createResolverFromDb(sdb, deps.logger);
}
