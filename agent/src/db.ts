import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

export function openAgentDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(sent_at);

    CREATE TABLE IF NOT EXISTS cache_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  return db;
}
