// Implements spec §4 Session Resolver.
import Database from "better-sqlite3";
import type { BotReplyStore } from "../types/index.js";

export type SessionRow = {
  slack_key: string;
  session_id: string;
  created_at: number;
  last_used_at: number;
};

export type SessionDb = {
  db: Database.Database;
  getBySlackKey: Database.Statement<[string], Pick<SessionRow, "session_id"> | undefined>;
  insertSession: Database.Statement<[string, string, number, number]>;
  updateLastUsed: Database.Statement<[number, string]>;
  updateSessionId: Database.Statement<[string, number, string]>;
  deleteByKey: Database.Statement<[string]>;
  existsBySlackKey: Database.Statement<[string], { one: number } | undefined>;
  close(): void;
};

export function openSessionDb(dbPath: string): SessionDb {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_sessions (
      slack_key    TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_replies (
      channel_id TEXT NOT NULL,
      thread_ts  TEXT NOT NULL,
      reply_ts   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, thread_ts, reply_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_replies_root
      ON bot_replies (channel_id, thread_ts);
  `);

  const getBySlackKey = db.prepare<[string], Pick<SessionRow, "session_id">>(
    "SELECT session_id FROM thread_sessions WHERE slack_key = ?",
  );
  const insertSession = db.prepare<[string, string, number, number]>(
    "INSERT INTO thread_sessions (slack_key, session_id, created_at, last_used_at) VALUES (?, ?, ?, ?)",
  );
  const updateLastUsed = db.prepare<[number, string]>(
    "UPDATE thread_sessions SET last_used_at = ? WHERE slack_key = ?",
  );
  const updateSessionId = db.prepare<[string, number, string]>(
    "UPDATE thread_sessions SET session_id = ?, last_used_at = ? WHERE slack_key = ?",
  );
  const deleteByKey = db.prepare<[string]>(
    "DELETE FROM thread_sessions WHERE slack_key = ?",
  );
  const existsBySlackKey = db.prepare<[string], { one: number }>(
    "SELECT 1 AS one FROM thread_sessions WHERE slack_key = ? LIMIT 1",
  );

  return {
    db,
    getBySlackKey,
    insertSession,
    updateLastUsed,
    updateSessionId,
    deleteByKey,
    existsBySlackKey,
    close: () => db.close(),
  };
}

/**
 * Store for tracking bot-authored reply ts values per thread so we can clean
 * them up when the user deletes the thread root. Uses the same shared DB
 * handle as the session store — pass in the `SessionDb` wrapper's `.db`.
 */
export function createBotReplyStore(
  db: Database.Database,
): BotReplyStore {
  const insertStmt = db.prepare<[string, string, string, number]>(
    "INSERT OR IGNORE INTO bot_replies (channel_id, thread_ts, reply_ts, created_at) VALUES (?, ?, ?, ?)",
  );
  const listStmt = db.prepare<
    [string, string],
    { reply_ts: string }
  >(
    "SELECT reply_ts FROM bot_replies WHERE channel_id = ? AND thread_ts = ? ORDER BY created_at ASC",
  );
  const deleteStmt = db.prepare<[string, string]>(
    "DELETE FROM bot_replies WHERE channel_id = ? AND thread_ts = ?",
  );

  return {
    record(channel_id, thread_ts, reply_ts): void {
      insertStmt.run(channel_id, thread_ts, reply_ts, Date.now());
    },
    list(channel_id, thread_ts): string[] {
      return listStmt.all(channel_id, thread_ts).map((r) => r.reply_ts);
    },
    drop(channel_id, thread_ts): void {
      deleteStmt.run(channel_id, thread_ts);
    },
  };
}
