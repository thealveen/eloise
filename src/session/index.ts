// Implements spec §4 Session Resolver.
import type { BotReplyStore, Logger, SessionResolver } from "../types/index.js";
import { createBotReplyStore, openSessionDb } from "./sqlite.js";
import { createResolverFromDb } from "./resolver.js";

export function createSessionResolver(deps: {
  dbPath: string;
  logger: Logger;
}): SessionResolver {
  const sdb = openSessionDb(deps.dbPath);
  return createResolverFromDb(sdb, deps.logger);
}

export function createSessionStores(deps: {
  dbPath: string;
  logger: Logger;
}): { sessionResolver: SessionResolver; botReplyStore: BotReplyStore } {
  const sdb = openSessionDb(deps.dbPath);
  return {
    sessionResolver: createResolverFromDb(sdb, deps.logger),
    botReplyStore: createBotReplyStore(sdb.db),
  };
}
