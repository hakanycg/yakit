import { db } from "../db/index.js";
import type { AlarmRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";

export function serializeAlarm(a: AlarmRow) {
  return {
    id: a.id,
    stationId: a.station_id,
    pumpId: a.pump_id,
    type: a.type,
    severity: a.severity,
    message: a.message,
    status: a.status,
    acknowledgedBy: a.acknowledged_by,
    acknowledgedAt: a.acknowledged_at,
    resolvedBy: a.resolved_by,
    resolvedAt: a.resolved_at,
    createdAt: a.created_at,
  };
}

export function createAlarm(params: {
  stationId: number;
  pumpId?: number | null;
  type: string;
  severity: AlarmRow["severity"];
  message: string;
}): AlarmRow {
  const result = db
    .prepare(`INSERT INTO alarms (station_id, pump_id, type, severity, message) VALUES (?, ?, ?, ?, ?)`)
    .run(params.stationId, params.pumpId ?? null, params.type, params.severity, params.message);
  const alarm = db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(result.lastInsertRowid as number)!;
  broadcastAlarms(params.stationId);
  return alarm;
}

export function listAlarms(stationId: number, status?: AlarmRow["status"]): AlarmRow[] {
  if (status) {
    return db
      .prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND status = ? ORDER BY created_at DESC")
      .all(stationId, status);
  }
  return db
    .prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? ORDER BY created_at DESC LIMIT 500")
    .all(stationId);
}

export function broadcastAlarms(stationId: number): void {
  broadcast(`alarms:${stationId}`, listAlarms(stationId, "active").map(serializeAlarm));
}
