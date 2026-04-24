// Implements spec §3 Slack Adapter.
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
  AgentProgressEvent,
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

// Heartbeat tunables. The placeholder only appears if a tool_use fires
// AND the turn is still running PLACEHOLDER_DELAY_MS after that first
// tool call. Fast tool-using turns that finish before the timer elapses
// never see a placeholder. Kept short enough that users don't stare at
// a lone 🤔 wondering if the bot is stuck.
const PLACEHOLDER_DELAY_MS = 3_000;
const UPDATE_DEBOUNCE_MS = 2_000;

/**
 * Minimal `client` surface the handler needs from Bolt's WebClient. Keeping
 * it narrow makes the handler trivial to mock in tests.
 */
export type SlackClient = ReactionsClient & {
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts: string;
      text: string;
    }): Promise<{ ts?: string } | unknown>;
    update(args: {
      channel: string;
      ts: string;
      text: string;
    }): Promise<unknown>;
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
    // Step 1: dedup seen-check only. `message_ts` (Slack's `ts`) uniquely
    // identifies a message; the same `ts` arriving twice means a duplicate
    // delivery (network retry, or app_mention + message double-fire for the
    // same mention). Skip silently — the original delivery is in flight.
    //
    // We deliberately do NOT mark() here. Marking is deferred until after the
    // K4 gate below, because when a channel @mention arrives as two events
    // (`app_mention` + `message.channels`) with non-deterministic order, we
    // must not let the `message.channels` event burn the dedup slot and
    // silently drop via K4 — that would block the paired `app_mention`.
    if (!raw.ts) return;
    if (deps.dedup.seen(raw.ts)) {
      deps.logger.debug("dedup hit", { message_ts: raw.ts });
      return;
    }

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
      // Don't mark dedup: the paired app_mention event for the same ts
      // still needs to go through.
      return;
    }

    // Commit to handling this event. Any duplicate delivery of the same ts
    // (from here on) should be treated as the paired double-fire and skipped.
    deps.dedup.mark(raw.ts);

    // Step 4: receipt UX. Add 🤔 immediately so the user sees we got it.
    await addReaction(client, event.channel_id, event.message_ts, THINKING, deps.logger);

    // Heartbeat poster: if the agent runs longer than PLACEHOLDER_DELAY_MS
    // and emits tool calls, it posts a "Thinking… _N tool calls · latest:
    // foo_" message into the thread and edits it as work continues. The
    // finalize() call at the end of each terminal branch reuses that
    // placeholder (via chat.update) so the thread ends up with one reply.
    const poster = createProgressPoster(
      client,
      event.channel_id,
      event.thread_ts,
      deps.logger,
    );

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
        // since we're not going to reply. Also cancel the poster — in
        // practice the agent never runs so no heartbeat fires, but belt
        // and braces.
        await poster.cancel();
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
        onProgress: poster.onProgress,
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
        // First-turn bookkeeping: our SQLite row was inserted with a
        // client-side UUID that the Agent SDK has never seen. Replace it
        // with the id the SDK actually minted so the next turn can resume.
        if (session.is_new && result.response.sdk_session_id) {
          await deps.sessionResolver.update(
            session.slack_key,
            result.response.sdk_session_id,
          );
        }
        const replyText = result.response.text;
        // Guard against empty/whitespace-only responses. Slack's
        // chat.postMessage rejects empty text with error code `no_text`; if
        // we ever reach this branch with empty text the upstream agent has
        // already logged something wrong. Convert to a user-facing error
        // rather than letting Slack throw.
        if (replyText.trim() === "") {
          await addReaction(
            client,
            event.channel_id,
            event.message_ts,
            ERROR_MARK,
            deps.logger,
          );
          await poster.finalize("Got no response — try again or rephrase.");
          logTurn(deps.logger, "error", event, session, {
            duration_ms: result.response.duration_ms,
            tool_calls: result.response.tool_calls,
            text_length: 0,
            sdk_subtype: result.response.sdk_subtype,
            sdk_num_turns: result.response.sdk_num_turns,
            error_message: "empty response",
          });
          return;
        }
        // Always post in-thread per the hard constraint. `event.thread_ts`
        // is guaranteed populated by normalize (top-level falls back to ts).
        // Text is passed through verbatim — system prompt is responsible for
        // producing valid Slack mrkdwn. Do NOT transform.
        //
        // If the heartbeat posted a "Thinking…" placeholder earlier, the
        // poster edits it in place so the thread ends up with exactly one
        // message per turn. Otherwise it falls back to chat.postMessage.
        await poster.finalize(replyText);
        logTurn(deps.logger, "ok", event, session, {
          duration_ms: result.response.duration_ms,
          tool_calls: result.response.tool_calls,
          text_length: replyText.length,
          sdk_subtype: result.response.sdk_subtype,
          sdk_num_turns: result.response.sdk_num_turns,
        });
      } else {
        // First-turn failure on a brand-new session: drop the row so the
        // user's retry starts clean. Leaving it would pin this thread to
        // a UUID the SDK will always reject.
        if (session.is_new) {
          await deps.sessionResolver.drop(session.slack_key);
        }
        // Agent reported a structured error. Add ❌ + post a friendly,
        // kind-specific message (K12). The full error is in the log only.
        await addReaction(
          client,
          event.channel_id,
          event.message_ts,
          ERROR_MARK,
          deps.logger,
        );
        await poster.finalize(formatErrorMessage(result.error));
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
      // Same is_new-drop rationale as the structured-error branch above.
      if (session?.is_new) {
        try {
          await deps.sessionResolver.drop(session.slack_key);
        } catch {
          // best effort
        }
      }
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
        await poster.finalize("Something went wrong.");
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
    text_length?: number;
    sdk_subtype?: string;
    sdk_num_turns?: number;
  },
): void {
  const fields = {
    slack_key: session?.slack_key,
    session_id: session?.session_id,
    user_id: event.user_id,
    text_preview: event.text.slice(0, 80),
    duration_ms: extras.duration_ms,
    tool_calls: extras.tool_calls,
    text_length: extras.text_length,
    sdk_subtype: extras.sdk_subtype,
    sdk_num_turns: extras.sdk_num_turns,
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

/**
 * Per-turn Slack heartbeat. See plan §2b: after PLACEHOLDER_DELAY_MS of
 * agent activity, post a "Thinking…" placeholder into the thread and edit
 * it as tool calls accumulate. Finalize by editing the placeholder with the
 * real reply, so the thread ends up with exactly one message per turn.
 *
 * Never throws. If `chat.update` fails (rate limited, deleted, etc.),
 * falls back to posting a fresh message so the user always gets a reply.
 */
type PosterResult = { posted: boolean; via: "update" | "postMessage" };

export function createProgressPoster(
  client: SlackClient,
  channel: string,
  thread_ts: string,
  logger: Logger,
): {
  onProgress: (ev: AgentProgressEvent) => void;
  finalize: (text: string) => Promise<PosterResult>;
  cancel: (fallbackText?: string) => Promise<void>;
} {
  let placeholderTs: string | undefined;
  let latestState: AgentProgressEvent | undefined;
  let lastUpdateAt = 0;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  // Serialize network calls so concurrent updates can't reorder.
  let chain: Promise<void> = Promise.resolve();

  function render(state: AgentProgressEvent): string {
    const n = state.tool_calls;
    const plural = n === 1 ? "" : "s";
    const tail = state.last_tool
      ? ` · latest: ${state.last_tool}`
      : "";
    return `Thinking… _${n} tool call${plural}${tail}_`;
  }

  function queue(fn: () => Promise<unknown>): Promise<void> {
    chain = chain.then(() => fn().then(() => undefined, () => undefined));
    return chain;
  }

  async function postPlaceholder(): Promise<void> {
    if (placeholderTs || !latestState) return;
    try {
      const res = (await client.chat.postMessage({
        channel,
        thread_ts,
        text: render(latestState),
      })) as { ts?: string } | undefined;
      if (res && typeof res.ts === "string") {
        placeholderTs = res.ts;
        lastUpdateAt = Date.now();
      }
    } catch (err) {
      logger.warn("placeholder post failed", {
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function updatePlaceholder(): Promise<void> {
    if (!placeholderTs || !latestState) return;
    try {
      await client.chat.update({
        channel,
        ts: placeholderTs,
        text: render(latestState),
      });
      lastUpdateAt = Date.now();
    } catch (err) {
      logger.warn("placeholder update failed", {
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function clearTimers(): void {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = undefined;
    }
    if (pendingUpdateTimer) {
      clearTimeout(pendingUpdateTimer);
      pendingUpdateTimer = undefined;
    }
  }

  return {
    onProgress(ev: AgentProgressEvent): void {
      latestState = ev;

      if (!placeholderTs) {
        if (!initialTimer) {
          initialTimer = setTimeout(() => {
            initialTimer = undefined;
            void queue(postPlaceholder);
          }, PLACEHOLDER_DELAY_MS);
        }
        return;
      }

      // Placeholder already up: debounce edits to UPDATE_DEBOUNCE_MS apart.
      const since = Date.now() - lastUpdateAt;
      if (since >= UPDATE_DEBOUNCE_MS) {
        if (pendingUpdateTimer) {
          clearTimeout(pendingUpdateTimer);
          pendingUpdateTimer = undefined;
        }
        void queue(updatePlaceholder);
      } else if (!pendingUpdateTimer) {
        pendingUpdateTimer = setTimeout(() => {
          pendingUpdateTimer = undefined;
          void queue(updatePlaceholder);
        }, UPDATE_DEBOUNCE_MS - since);
      }
    },

    async finalize(text: string): Promise<PosterResult> {
      clearTimers();
      // Wait for any in-flight posts to settle so we don't race the edit.
      await chain;

      if (placeholderTs) {
        try {
          await client.chat.update({ channel, ts: placeholderTs, text });
          return { posted: true, via: "update" };
        } catch (err) {
          logger.warn("finalize update failed, posting fresh", {
            error_message: err instanceof Error ? err.message : String(err),
          });
          // fall through to postMessage
        }
      }
      await client.chat.postMessage({ channel, thread_ts, text });
      return { posted: true, via: "postMessage" };
    },

    async cancel(fallbackText?: string): Promise<void> {
      clearTimers();
      await chain;
      if (placeholderTs && fallbackText !== undefined) {
        try {
          await client.chat.update({
            channel,
            ts: placeholderTs,
            text: fallbackText,
          });
        } catch {
          // best effort
        }
      }
    },
  };
}
