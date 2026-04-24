// Implements spec §3 Slack Adapter.
/**
 * Pure transformation from a raw Slack event payload into the
 * `NormalizedEvent` consumed by the rest of the bot.
 *
 * Returns `null` when the event should be filtered out — keeping every
 * "should I process this?" decision in one place makes the handler trivial.
 *
 * Filter rules (in order, all per slack-bot-spec.md §3):
 *   1. Drop messages with `bot_id` set or `subtype === 'bot_message'`
 *      (catches the bot's own messages and other bots).
 *   2. Drop any other message subtypes (`message_changed`, `message_deleted`,
 *      `channel_join`, etc.) — we only respond to fresh user text.
 *   3. Drop messages with no `user` or no `text` — defensive; shouldn't happen
 *      for the events we subscribe to, but keeps the contract clean.
 *   4. Drop messages whose only content is a leading bot mention
 *      (empty after stripping + trimming).
 *
 * Thread-key rule (K3): for top-level messages, `thread_ts` is absent; we
 * fill it from `ts` so downstream code can treat every event as having a
 * `thread_ts`. This keeps the slack_key construction in the Session Resolver
 * uniform.
 */

import type { NormalizedEvent } from "../types/index.js";

/**
 * Shape we accept from Bolt. Kept loose intentionally — Bolt's union types
 * for `app_mention` vs `message` events differ, but normalization only
 * cares about the common subset. Anything missing leads to `null`.
 */
export type RawSlackEvent = {
  type?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  // Present on `message_deleted` events: the ts of the deleted message.
  deleted_ts?: string;
};

// Slack user mentions in message text are encoded as `<@U12345678>`. We strip
// only a LEADING mention (the bot being addressed), preserving any in-text
// mentions of other users so Claude can see who was referenced.
const LEADING_MENTION_RE = /^<@[UW][A-Z0-9]+>\s*/;

export function normalize(raw: RawSlackEvent, botUserId: string | null): NormalizedEvent | null {
  // Rule 1: bot messages (own + others). `bot_id` is the canonical signal.
  if (raw.bot_id) return null;
  if (raw.subtype === "bot_message") return null;

  // Belt-and-suspenders: even if Slack echoes our own user back, drop it.
  // Required because `app_mention` doesn't carry `bot_id`.
  if (botUserId && raw.user === botUserId) return null;

  // Rule 2: only respond to plain new messages. Any subtype is a system
  // event we should ignore. (`undefined` subtype = a normal user message.)
  if (raw.subtype !== undefined) return null;

  // Rule 3: defensive on missing required fields.
  if (!raw.ts || !raw.channel || !raw.user || typeof raw.text !== "string") {
    return null;
  }

  // K4: strip the leading @bot mention before sending text downstream so
  // Claude sees just the user's intent, not the addressing token.
  const text = raw.text.replace(LEADING_MENTION_RE, "").trim();

  // Rule 4.
  if (text.length === 0) return null;

  // K3: top-level messages have no `thread_ts`; alias it to the message's
  // own `ts` so the slack_key is `{channel}:{message_ts}` for top-level and
  // `{channel}:{parent_ts}` for replies.
  const thread_ts = raw.thread_ts ?? raw.ts;

  // `channel_type === 'im'` is the official DM marker. Channel IDs starting
  // with 'D' work too but `channel_type` is more reliable.
  const source: NormalizedEvent["source"] = raw.channel_type === "im" ? "dm" : "channel";

  return {
    source,
    channel_id: raw.channel,
    thread_ts,
    message_ts: raw.ts,
    user_id: raw.user,
    text,
  };
}

/**
 * Deletion events ride on `message` with `subtype: "message_deleted"`, which
 * `normalize()` filters out (deletes aren't normal turns). This sibling
 * function extracts just what the deletion path needs: the channel and the
 * `ts` of the message that disappeared.
 *
 * Returns `null` unless the event is a genuine user-driven deletion with
 * both `channel` and `deleted_ts` populated.
 */
export type NormalizedDeletion = {
  channel_id: string;
  deleted_ts: string;
};

export function normalizeDeletion(
  raw: RawSlackEvent,
): NormalizedDeletion | null {
  if (raw.subtype !== "message_deleted") return null;
  if (!raw.channel || !raw.deleted_ts) return null;
  return { channel_id: raw.channel, deleted_ts: raw.deleted_ts };
}

/**
 * True if this normalized event is a thread reply (not a top-level message).
 * Used by the channel-non-mention gate: per spec §3.3, we only process
 * non-mention channel messages if they're replies to an existing thread.
 *
 * Caller passes the raw event because `NormalizedEvent` aliases `thread_ts`
 * to `ts` for top-level messages — the original `thread_ts` field is the
 * only reliable signal that the user threaded their reply.
 */
export function isThreadReply(raw: RawSlackEvent): boolean {
  return typeof raw.thread_ts === "string" && raw.thread_ts !== raw.ts;
}
