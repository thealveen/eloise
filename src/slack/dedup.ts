/**
 * In-memory de-duplication of Slack message timestamps.
 *
 * Why this exists: Slack's Events API can deliver the same event more than
 * once (network retries, redeliveries, and the fact that an @-mention fires
 * BOTH `app_mention` and `message` events for the same `ts`). Bolt dedupes
 * some duplicates but not all. Without a guard, a single user message can
 * cause the agent to run twice and post two replies.
 *
 * The `message_ts` (Slack's per-message timestamp) is unique enough to use
 * as the dedup key. We keep it for a TTL window — long enough to catch
 * duplicates that arrive seconds apart, short enough to bound memory.
 *
 * Acceptable for v1 per the task brief. Multi-process deployments would need
 * a shared store (Redis), but this bot is single-VPS.
 */

export type Dedup = {
  /** Returns true iff `ts` was marked within the TTL window. */
  seen(ts: string): boolean;
  /** Records `ts` so subsequent `seen()` calls return true until expiry. */
  mark(ts: string): void;
};

export function createDedup(opts: { ttlMs: number }): Dedup {
  // Map preserves insertion order, which lets a single forward-walking sweep
  // stop as soon as it hits an unexpired entry.
  const seenAt = new Map<string, number>();

  function sweep(now: number): void {
    for (const [ts, expiresAt] of seenAt) {
      if (expiresAt > now) break;
      seenAt.delete(ts);
    }
  }

  return {
    seen(ts: string): boolean {
      const expiresAt = seenAt.get(ts);
      if (expiresAt === undefined) return false;
      // Lazy expiry: a stale entry counts as "not seen".
      if (expiresAt <= Date.now()) {
        seenAt.delete(ts);
        return false;
      }
      return true;
    },
    mark(ts: string): void {
      const now = Date.now();
      sweep(now);
      seenAt.set(ts, now + opts.ttlMs);
    },
  };
}
