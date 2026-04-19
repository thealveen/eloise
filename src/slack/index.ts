/**
 * Slack Adapter — public entry.
 *
 * This component is the boundary between Slack (via Bolt Socket Mode) and
 * the rest of the bot. It receives events, normalizes them, hands off to
 * the Session Resolver and Agent Runner, and posts replies back into the
 * triggering thread.
 *
 * The factory does not connect to Slack — it only wires internal pieces
 * together. `start()` performs the actual Socket Mode handshake. This split
 * lets the composition root construct everything synchronously and lets
 * tests instantiate the factory without network I/O.
 *
 * See slack-bot-spec.md §3 for responsibilities and §10.4 for the frozen
 * factory signature this module conforms to.
 */

import type { AgentRunner, Logger, SessionResolver } from "../types/index.js";
import { createBoltApp } from "./bolt-client.js";
import { createDedup } from "./dedup.js";
import { createEventHandler } from "./handler.js";

// 10 minutes is plenty: Slack redeliveries arrive within seconds; this just
// keeps memory bounded for a long-running process.
const DEDUP_TTL_MS = 10 * 60 * 1000;

export function createSlackAdapter(deps: {
  botToken: string;
  appToken: string;
  sessionResolver: SessionResolver;
  agentRunner: AgentRunner;
  logger: Logger;
}): { start(): Promise<void>; stop(): Promise<void> } {
  const dedup = createDedup({ ttlMs: DEDUP_TTL_MS });

  const handler = createEventHandler({
    sessionResolver: deps.sessionResolver,
    agentRunner: deps.agentRunner,
    logger: deps.logger,
    dedup,
  });

  const bolt = createBoltApp({
    botToken: deps.botToken,
    appToken: deps.appToken,
    handler,
    logger: deps.logger,
  });

  return {
    async start() {
      await bolt.start();
      deps.logger.info("slack adapter started");
    },
    async stop() {
      await bolt.stop();
      deps.logger.info("slack adapter stopped");
    },
  };
}
