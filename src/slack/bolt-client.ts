// Implements spec §3 Slack Adapter.
/**
 * Bolt App construction + Socket Mode wiring for the Slack Adapter.
 *
 * What lives here:
 *   - Build a Bolt `App` configured for Socket Mode (no public URL needed)
 *   - Subscribe to `app_mention` and `message` events; route both into the
 *     injected `EventHandler`
 *   - Resolve the bot's own user ID via `auth.test()` after connect, so the
 *     normalizer can drop echoes of our own messages
 *   - Forward Socket Mode connect/disconnect/reconnect events into the
 *     structured logger (Bolt auto-reconnects; we don't manage the loop)
 *   - Expose `start()` / `stop()` for the factory
 *
 * What does NOT live here: any business logic. The handler module owns the
 * per-turn flow. This file is a thin glue layer between Bolt's transport
 * and our handler.
 */

import { App, SocketModeReceiver } from "@slack/bolt";
import type { Logger } from "../types/index.js";
import type { EventHandler } from "./handler.js";
import type { RawSlackEvent } from "./normalize.js";

export type BoltClient = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createBoltApp(deps: {
  botToken: string;
  appToken: string;
  handler: EventHandler;
  logger: Logger;
}): BoltClient {
  // We build the SocketModeReceiver explicitly (rather than letting App
  // construct one via `socketMode: true`) so we can attach listeners to its
  // underlying `client` for connect/disconnect logging.
  const receiver = new SocketModeReceiver({
    appToken: deps.appToken,
  });

  const app = new App({
    token: deps.botToken,
    receiver,
  });

  // app_mention: fires whenever someone @mentions the bot. Always allowed
  // to start or continue a session (K4).
  app.event("app_mention", async ({ event, client }) => {
    // Bolt's typed events are a discriminated union; we cast to our loose
    // `RawSlackEvent` shape because normalization treats missing fields
    // defensively. The cast is safe — the handler never assumes anything
    // beyond what `normalize` checks.
    await deps.handler.handle(event as unknown as RawSlackEvent, client, "mention");
  });

  // message: fires for DMs (`message.im`) and channel messages
  // (`message.channels`). The handler applies the K4 channel-non-mention
  // gate to filter channel events down to thread replies on existing
  // sessions.
  app.message(async ({ message, client }) => {
    await deps.handler.handle(message as unknown as RawSlackEvent, client, "message");
  });

  // Bolt routes errors that bubble out of listeners here. Anything that
  // reaches this point already escaped our handler's top-level catch — log
  // loudly so we know about the bug.
  app.error(async (err) => {
    deps.logger.error("bolt error handler invoked", {
      error_message: err instanceof Error ? err.message : String(err),
    });
  });

  // Socket Mode lifecycle logging (spec §9 failure-mode-matrix row 1).
  // The SocketModeClient is an EventEmitter exposing these states:
  //   connecting | connected | reconnecting | disconnecting | disconnected
  // We only forward the user-meaningful ones.
  receiver.client.on("connected", () => {
    deps.logger.info("slack socket connected");
    // Resolve the bot's user ID once connected. We need it so the
    // normalizer can drop our own message echoes (they lack `bot_id`).
    // Fire-and-forget: a failure here just leaves botUserId null, which is
    // a slight degradation but not a crash.
    app.client.auth
      .test()
      .then((res) => {
        if (res.user_id) {
          deps.handler.setBotUserId(res.user_id);
          deps.logger.debug("resolved bot user id", { user_id: res.user_id });
        }
      })
      .catch((err) => {
        deps.logger.warn("auth.test failed", {
          error_message: err instanceof Error ? err.message : String(err),
        });
      });
  });

  receiver.client.on("disconnected", () => {
    deps.logger.warn("slack socket disconnected");
  });

  receiver.client.on("reconnecting", () => {
    deps.logger.info("slack socket reconnecting");
  });

  return {
    async start() {
      await app.start();
    },
    async stop() {
      await app.stop();
    },
  };
}
