import { v4 as uuidv4 } from "uuid";
import type {
  Logger,
  NormalizedEvent,
  SessionHandle,
  SessionResolver,
} from "../types/index.js";
import type { SessionDb } from "./sqlite.js";

// `:` is unambiguous as a separator: Slack channel IDs are uppercase alnum
// and thread_ts is a numeric string, so neither can contain `:`.
export function slackKey(channel_id: string, thread_ts: string): string {
  return `${channel_id}:${thread_ts}`;
}

function defaultClock(): number {
  return Math.floor(Date.now() / 1000);
}

export function createResolverFromDb(
  sdb: SessionDb,
  logger: Logger,
  clock: () => number = defaultClock,
): SessionResolver {
  // Wrap read-then-insert in a transaction so concurrent callers can't both
  // observe "missing" and then race to INSERT the same slack_key.
  const resolveTxn = sdb.db.transaction((key: string, now: number): SessionHandle => {
    const row = sdb.getBySlackKey.get(key);
    if (row) {
      sdb.updateLastUsed.run(now, key);
      return { session_id: row.session_id, is_new: false, slack_key: key };
    }
    const session_id = uuidv4();
    sdb.insertSession.run(key, session_id, now, now);
    return { session_id, is_new: true, slack_key: key };
  });

  return {
    resolve(event: NormalizedEvent): Promise<SessionHandle> {
      const key = slackKey(event.channel_id, event.thread_ts);
      const handle = resolveTxn(key, clock());
      logger.debug("session_resolved", {
        slack_key: handle.slack_key,
        session_id: handle.session_id,
        is_new: handle.is_new,
      });
      return Promise.resolve(handle);
    },

    exists(channel_id: string, thread_ts: string): Promise<boolean> {
      const row = sdb.existsBySlackKey.get(slackKey(channel_id, thread_ts));
      return Promise.resolve(row !== undefined);
    },
  };
}
