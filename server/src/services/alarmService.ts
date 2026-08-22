import { db } from "../db/index.js";
import type { AlarmRow, StationRow, UserRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";
import { sendEmail, sendSms } from "./notificationService.js";
import { enqueueWrite, registerWriteQueueHandler } from "./writeQueueService.js";

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
  if (alarm.severity === "critical") {
    // Dogrudan (fire-and-forget) cagirmak yerine dayanikli kuyruga yazilir (bkz.
    // writeQueueService.ts) - sunucu tam bu sirada coksun/SMTP-SMS saglayicisi
    // gecici olarak erisilemez olsun, bildirim SESSIZCE KAYBOLMAZ; bir sonraki
    // processWriteQueue() turunda otomatik olarak (gerekirse tekrar) denenir.
    enqueueWrite("critical_alarm_notification", alarm);
  }
  return alarm;
}

registerWriteQueueHandler("critical_alarm_notification", async (payload) => {
  await notifyCriticalAlarm(payload as AlarmRow);
});

/** Istasyonun bildirim tercihi acik olan admin/operator kullanicilarina e-posta/SMS gonderir. Hata durumunda cagiran taraf (write queue) tekrar dener. */
async function notifyCriticalAlarm(alarm: AlarmRow): Promise<void> {
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(alarm.station_id);
  if (!station) return;

  const recipients = db
    .prepare<[number], UserRow>(
      `SELECT u.* FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.station_id = ? AND u.active = 1 AND r.name IN ('admin', 'operator')`
    )
    .all(alarm.station_id);

  const subject = `[KRITIK ALARM] ${station.name}`;
  const text = `${station.name} istasyonunda kritik bir alarm olustu:\n\n${alarm.message}\n\nZaman: ${new Date(alarm.created_at).toLocaleString("tr-TR")}`;

  await Promise.all(
    recipients.flatMap((u) => {
      const tasks: Promise<unknown>[] = [];
      if (u.notify_email && u.email) tasks.push(sendEmail(u.email, subject, text));
      if (u.notify_sms && u.phone) tasks.push(sendSms(u.phone, `${subject}: ${alarm.message}`));
      return tasks;
    })
  );
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
