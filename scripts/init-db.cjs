#!/usr/bin/env node
/* eslint-disable */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const dataDir = path.resolve(__dirname, "..", "data");
const dbPath = path.join(dataDir, "sessions.db");

fs.mkdirSync(dataDir, { recursive: true });

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

db.close();

console.log(`initialized ${dbPath}`);
