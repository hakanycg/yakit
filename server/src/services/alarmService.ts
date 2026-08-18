import { db } from "../db/index.js";
import type { AlarmRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";

export function serializeAlarm(a: AlarmRow) {
  return {
    id: a.id,
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
  pumpId?: number | null;
  type: string;
  severity: AlarmRow["severity"];
  message: string;
}): AlarmRow {
  const result = db
    .prepare(`INSERT INTO alarms (pump_id, type, severity, message) VALUES (?, ?, ?, ?)`)
    .run(params.pumpId ?? null, params.type, params.severity, params.message);
  const alarm = db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(result.lastInsertRowid as number)!;
  broadcastAlarms();
  return alarm;
}

export function listAlarms(status?: AlarmRow["status"]): AlarmRow[] {
  if (status) {
    return db.prepare<[string], AlarmRow>("SELECT * FROM alarms WHERE status = ? ORDER BY created_at DESC").all(status);
  }
  return db.prepare<[], AlarmRow>("SELECT * FROM alarms ORDER BY created_at DESC LIMIT 500").all();
}

export function broadcastAlarms(): void {
  broadcast("alarms", listAlarms("active").map(serializeAlarm));
}
