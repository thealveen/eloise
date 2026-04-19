// Implements spec §4 Session Resolver.
import Database from "better-sqlite3";

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
  const existsBySlackKey = db.prepare<[string], { one: number }>(
    "SELECT 1 AS one FROM thread_sessions WHERE slack_key = ? LIMIT 1",
  );

  return {
    db,
    getBySlackKey,
    insertSession,
    updateLastUsed,
    existsBySlackKey,
    close: () => db.close(),
  };
}
