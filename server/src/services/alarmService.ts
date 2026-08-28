import { db } from "../db/index.js";
import type { AlarmRow, StationRow, UserRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";
import { sendEmail, sendSms } from "./notificationService.js";
import { enqueueWrite, registerWriteQueueHandler } from "./writeQueueService.js";
import { dispatchAlarmWebhook } from "./webhookSettingsService.js";

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
    // Cevapsiz kritik alarmin kacinci asamada oldugu: operator "haber verildi mi?"
    // sorusunun cevabini alarm listesinde gorebilmeli.
    escalationLevel: a.escalation_level,
    lastNotifiedAt: a.last_notified_at,
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
    // Ilk bildirim yapildi; bundan sonrasi (cevap gelmezse hatirlatma ve yukseltme)
    // periyodik taramanin isi - bkz. services/alarmEscalationService.ts.
    db.prepare("UPDATE alarms SET last_notified_at = ? WHERE id = ?").run(new Date().toISOString(), alarm.id);
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

  const tasks: Promise<unknown>[] = recipients.flatMap((u) => {
    const t: Promise<unknown>[] = [];
    if (u.notify_email && u.email) t.push(sendEmail(u.email, subject, text));
    if (u.notify_sms && u.phone) t.push(sendSms(u.phone, `${subject}: ${alarm.message}`));
    return t;
  });
  // E-posta/SMS'e EK olarak (yerine degil) - istasyonun bir webhook'u varsa (bkz.
  // webhookSettingsService.ts) SIEM/ops aracina da bildirilir.
  tasks.push(dispatchAlarmWebhook(alarm.station_id, station.name, alarm, "critical_alarm"));
  await Promise.all(tasks);
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

export interface AlarmListFilters {
  status?: AlarmRow["status"];
  severity?: AlarmRow["severity"];
  type?: string;
  pumpId?: number;
  /** YYYY-MM-DD, dahil. */
  from?: string;
  /** YYYY-MM-DD, dahil (gunun sonuna kadar uzatilir). */
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedAlarms {
  alarms: AlarmRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Alarm Merkezi ekrani icin filtreli + SAYFALI liste. listAlarms()'in aksine
 * (o, sadece status'e gore dallanan iki sabit sorgu - broadcastAlarms ve
 * eski cagiranlarin davranisini degistirmemek icin dokunulmadi) burada dinamik
 * bir WHERE ve HER ZAMAN bir LIMIT/OFFSET vardir - filtre uygulansa da
 * uygulanmasa da sonuc sinirsiz BUYUYEMEZ (eski listAlarms'ta status verilince
 * hicbir sinir yoktu, bu bir olcekleme hatasiydi).
 */
export function listAlarmsPaged(stationId: number, filters: AlarmListFilters = {}): PagedAlarms {
  const clauses = ["station_id = ?"];
  const params: (string | number)[] = [stationId];
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.severity) {
    clauses.push("severity = ?");
    params.push(filters.severity);
  }
  if (filters.type) {
    clauses.push("type = ?");
    params.push(filters.type);
  }
  if (filters.pumpId !== undefined) {
    clauses.push("pump_id = ?");
    params.push(filters.pumpId);
  }
  if (filters.from) {
    clauses.push("created_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("created_at <= ?");
    params.push(`${filters.to}T23:59:59.999Z`);
  }
  const where = clauses.join(" AND ");

  const total = (db.prepare(`SELECT COUNT(*) as c FROM alarms WHERE ${where}`).get(...params) as { c: number }).c;

  const page = Math.max(filters.page ?? 1, 1);
  const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 100);
  const offset = (page - 1) * pageSize;

  const alarms = db
    .prepare<(string | number)[], AlarmRow>(`SELECT * FROM alarms WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);

  return { alarms, total, page, pageSize };
}

export function broadcastAlarms(stationId: number): void {
  broadcast(`alarms:${stationId}`, listAlarms(stationId, "active").map(serializeAlarm));
}
