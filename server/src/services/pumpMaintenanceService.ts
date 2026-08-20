import { db } from "../db/index.js";
import type { PumpMaintenanceLogRow, PumpMaintenanceLogType, UserRow } from "../db/types.js";

export function serializeMaintenanceLog(row: PumpMaintenanceLogRow, username: string | null) {
  return {
    id: row.id,
    pumpId: row.pump_id,
    type: row.type,
    description: row.description,
    username,
    createdAt: row.created_at,
  };
}

export function listMaintenanceLogs(stationId: number, pumpId: number): (PumpMaintenanceLogRow & { username: string | null })[] {
  return db
    .prepare<[number, number], PumpMaintenanceLogRow & { username: string | null }>(
      `SELECT m.*, u.username as username
       FROM pump_maintenance_logs m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.station_id = ? AND m.pump_id = ?
       ORDER BY m.created_at DESC`
    )
    .all(stationId, pumpId);
}

export function addMaintenanceLog(
  stationId: number,
  pumpId: number,
  type: PumpMaintenanceLogType,
  description: string,
  actor: UserRow
): PumpMaintenanceLogRow {
  const result = db
    .prepare("INSERT INTO pump_maintenance_logs (station_id, pump_id, type, description, user_id) VALUES (?, ?, ?, ?, ?)")
    .run(stationId, pumpId, type, description, actor.id);
  return db.prepare<[number], PumpMaintenanceLogRow>("SELECT * FROM pump_maintenance_logs WHERE id = ?").get(result.lastInsertRowid as number)!;
}
