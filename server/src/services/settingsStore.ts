import { db } from "../db/index.js";
import type { UserRow } from "../db/types.js";

export function getSetting(stationId: number, key: string): string | null {
  const row = db
    .prepare<[number, string], { value: string }>("SELECT value FROM settings WHERE station_id = ? AND key = ?")
    .get(stationId, key);
  return row?.value ?? null;
}

export function setSetting(stationId: number, key: string, value: string, actor: UserRow | null): void {
  db.prepare(
    `INSERT INTO settings (station_id, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(station_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(stationId, key, value, new Date().toISOString(), actor?.id ?? null);
}
