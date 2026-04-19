/**
 * Per-event orchestrator for the Slack Adapter.
 *
 * Owns the full lifecycle of a single Slack message turn:
 *   1. Dedup against duplicate Bolt deliveries
 *   2. Normalize + filter the raw event
 *   3. Apply the K4 channel-non-mention gate (only continue if a session
 *      already exists for that thread)
 *   4. Add 🤔 reaction
 *   5. Resolve session
 *   6. Run the agent
 *   7. Post the reply in-thread, swap 🤔 for nothing (success) or ❌ (error)
 *   8. Emit exactly one structured log line per turn (per spec §9)
 *
 * Lives separately from `bolt-client.ts` so it can be unit-tested without
 * booting a real Bolt App.
 *
 * The `source` parameter ('mention' | 'message') reflects which Bolt
 * subscription delivered the event. We need it because:
 *   - `app_mention` and `message` both fire for the same user message that
 *     contains a bot mention; dedup handles that.
 *   - The K4 gate only applies to `message`-source events in channels
 *     (a `mention`-source event is *always* allowed to start or continue
 *     a session).
 */

import type {
  AgentRunner,
  Logger,
  NormalizedEvent,
  SessionResolver,
} from "../types/index.js";
import type { Dedup } from "./dedup.js";
import { formatErrorMessage } from "./format.js";
import { isThreadReply, normalize, type RawSlackEvent } from "./normalize.js";
import { addReaction, removeReaction, type ReactionsClient } from "./reactions.js";

const THINKING = "thinking_face";
const ERROR_MARK = "x";

/**
 * Minimal `client` surface the handler needs from Bolt's WebClient. Keeping
 * it narrow makes the handler trivial to mock in tests.
 */
export type SlackClient = ReactionsClient & {
  chat: {
    postMessage(args: { channel: string; thread_ts: string; text: string }): Promise<unknown>;
  };
};

export type EventSource = "mention" | "message";

export type EventHandler = {
  handle(raw: RawSlackEvent, client: SlackClient, source: EventSource): Promise<void>;
  /** Set the bot's own user ID once Bolt connects. Used by normalize to drop
   *  echoes of the bot's own messages (which lack `bot_id` on `app_mention`). */
  setBotUserId(id: string): void;
};

export function createEventHandler(deps: {
  sessionResolver: SessionResolver;
  agentRunner: AgentRunner;
  logger: Logger;
  dedup: Dedup;
}): EventHandler {
  let botUserId: string | null = null;

  async function handle(
    raw: RawSlackEvent,
    client: SlackClient,
    source: EventSource,
  ): Promise<void> {
    // Step 1: dedup. `message_ts` (Slack's `ts`) uniquely identifies a
    // message; the same `ts` arriving twice means a duplicate delivery
    // (network retry, or app_mention + message double-fire for the same
    // mention). Skip silently — the original delivery is in flight.
    if (!raw.ts) return;
    if (deps.dedup.seen(raw.ts)) {
      deps.logger.debug("dedup hit", { message_ts: raw.ts });
      return;
    }
    deps.dedup.mark(raw.ts);

    // Step 2: normalize + filter. Returns null for any event we shouldn't
    // act on (own/bot messages, edits/deletes, empty text, etc.).
    const event = normalize(raw, botUserId);
    if (!event) return;

    // Step 3: K4 channel-non-mention gate (spec §3 responsibility 3).
    // For `message`-source events in channels:
    //   - If it's a top-level message (no thread_ts on the raw event), drop —
    //     a top-level channel message must @mention to engage.
    //   - If it IS a thread reply, only continue if the thread already has
    //     a session. We check that AFTER calling resolve() because the
    //     SessionResolver interface only exposes resolve() (which creates if
    //     missing). If `is_new`, the resolver had to insert — we'll abandon
    //     the row. Acceptable cost for v1; a future `peek()` method on
    //     SessionResolver would eliminate the orphan.
    const isChannelNonMention = event.source === "channel" && source === "message";
    if (isChannelNonMention && !isThreadReply(raw)) {
      // Top-level channel message without an @mention — not for us.
      return;
    }

    // Step 4: receipt UX. Add 🤔 immediately so the user sees we got it.
    await addReaction(client, event.channel_id, event.message_ts, THINKING, deps.logger);

    // Top-level try/catch wraps everything from here on so that ANY thrown
    // error (resolver crash, Slack API failure, programming bug) still ends
    // the turn with a user-facing message and a structured log line. Per
    // task brief: never silently swallow.
    const turnStart = Date.now();
    let session: { session_id: string; is_new: boolean; slack_key: string } | null = null;
    try {
      session = await deps.sessionResolver.resolve(event);

      // Step 3 (continued): the K4 gate after resolution.
      if (isChannelNonMention && session.is_new) {
        // A new thread reply with no prior session — ignore. Clear the 🤔
        // since we're not going to reply.
        await removeReaction(
          client,
          event.channel_id,
          event.message_ts,
          THINKING,
          deps.logger,
        );
        deps.logger.debug("ignored channel reply (no existing session)", {
          slack_key: session.slack_key,
          session_id: session.session_id,
          user_id: event.user_id,
        });
        return;
      }

      // Step 5 + 6: run the agent. Errors from the runner come back as
      // `{ ok: false, error }` — they don't throw — so we handle them in-line.
      const result = await deps.agentRunner.run({
        session,
        user_text: event.text,
        meta: { user_id: event.user_id, slack_key: session.slack_key },
      });

      // Step 7a: clear 🤔 before posting (so the user doesn't see both
      // 🤔 and the reply for a brief moment).
      await removeReaction(
        client,
        event.channel_id,
        event.message_ts,
        THINKING,
        deps.logger,
      );

      if (result.ok) {
        // Always post in-thread per the hard constraint. `event.thread_ts`
        // is guaranteed populated by normalize (top-level falls back to ts).
        // Text is passed through verbatim — system prompt is responsible for
        // producing valid Slack mrkdwn. Do NOT transform.
        await client.chat.postMessage({
          channel: event.channel_id,
          thread_ts: event.thread_ts,
          text: result.response.text,
        });
        logTurn(deps.logger, "ok", event, session, {
          duration_ms: result.response.duration_ms,
          tool_calls: result.response.tool_calls,
        });
      } else {
        // Agent reported a structured error. Add ❌ + post a friendly,
        // kind-specific message (K12). The full error is in the log only.
        await addReaction(
          client,
          event.channel_id,
          event.message_ts,
          ERROR_MARK,
          deps.logger,
        );
        await client.chat.postMessage({
          channel: event.channel_id,
          thread_ts: event.thread_ts,
          text: formatErrorMessage(result.error),
        });
        const status = result.error.kind === "timeout" ? "timeout" : "error";
        logTurn(deps.logger, status, event, session, {
          duration_ms: Date.now() - turnStart,
          error_message: serializeAgentError(result.error),
        });
      }
    } catch (err) {
      // Anything that threw — resolver crashed, Slack API rejected our post,
      // bug in our own code — surfaces here. We MUST tell the user something
      // and log. Never silently swallow.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await removeReaction(
          client,
          event.channel_id,
          event.message_ts,
          THINKING,
          deps.logger,
        );
        await addReaction(
          client,
          event.channel_id,
          event.message_ts,
          ERROR_MARK,
          deps.logger,
        );
        await client.chat.postMessage({
          channel: event.channel_id,
          thread_ts: event.thread_ts,
          text: "Something went wrong.",
        });
      } catch {
        // If even the apology post fails, give up on UX — but the log line
        // below still fires so we know something went wrong.
      }
      logTurn(deps.logger, "error", event, session, {
        duration_ms: Date.now() - turnStart,
        error_message: message,
      });
    }
  }

  return {
    handle,
    setBotUserId(id: string): void {
      botUserId = id;
    },
  };
}

/**
 * Emit the single per-turn log line required by spec §9.
 * Keeping this in one place ensures every code path produces the same shape.
 */
function logTurn(
  logger: Logger,
  status: "ok" | "error" | "timeout",
  event: NormalizedEvent,
  session: { session_id: string; slack_key: string } | null,
  extras: {
    duration_ms?: number;
    tool_calls?: number;
    error_message?: string;
  },
): void {
  const fields = {
    slack_key: session?.slack_key,
    session_id: session?.session_id,
    user_id: event.user_id,
    text_preview: event.text.slice(0, 80),
    duration_ms: extras.duration_ms,
    tool_calls: extras.tool_calls,
    status,
    error_message: extras.error_message,
  };
  if (status === "ok") {
    logger.info("turn ok", fields);
  } else {
    logger.error(`turn ${status}`, fields);
  }
}

function serializeAgentError(error: {
  kind: string;
  message?: string;
}): string {
  return error.message ? `${error.kind}: ${error.message}` : error.kind;
}
