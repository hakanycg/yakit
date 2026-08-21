import type Database from "better-sqlite3";

export interface CacheSnapshot {
  updatedAt: string;
  data: unknown;
}

export function saveCacheSnapshot(db: Database.Database, data: unknown): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cache_snapshot (id, data, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(JSON.stringify(data), now);
}

export function readCacheSnapshot(db: Database.Database): CacheSnapshot | null {
  const row = db.prepare("SELECT data, updated_at FROM cache_snapshot WHERE id = 1").get() as
    | { data: string; updated_at: string }
    | undefined;
  if (!row) return null;
  return { updatedAt: row.updated_at, data: JSON.parse(row.data) };
}
