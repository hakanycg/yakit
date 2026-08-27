import { db } from "../db/index.js";
import type { AlarmRow, StationRow, UserRow } from "../db/types.js";
import { sendEmail, sendSms } from "./notificationService.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { enqueueWrite, registerWriteQueueHandler } from "./writeQueueService.js";
import { dispatchAlarmWebhook } from "./webhookSettingsService.js";
import { logger } from "../utils/logger.js";

/**
 * Kritik alarm yukseltme - cevapsiz alarmin pesini birakmama.
 *
 * Kritik bir alarm olustugunda BIR KEZ bildirim gonderiliyor ve sistem susuyordu. Gece
 * 3'te telefon sessizdeyse, e-posta spam'e dustuyse ya da tek operator uyuyorsa bir daha
 * konusan olmuyordu. Personelsiz istasyonda onemli olan senaryo tam da budur: goren
 * kimsenin olmadigi alarm, istasyonu yakan alarmdir.
 *
 * Uc asama vardir:
 *   0 -> ilk bildirim (createAlarm sirasinda, bu servisten once)
 *   1 -> hatirlatma: ayni kisilere tekrar
 *   2 -> yukseltme: dagitim sirketi yoneticisi + platform yoneticisi de eklenir
 *
 * Sonra DURUR. Sinirsiz tekrar, insanlarin kanali tamamen susturmasina yol acar ve
 * ozelligi cozmeye calistigi sorunun ta kendisine donusturur.
 */

/**
 * Yukseltme, alarm ONAYLANINCA durur - COZULMESI beklenmez.
 *
 * "acknowledged" bir insanin alarmi gordugu ve ilgilendigi anlamina gelir. Sahada
 * ariza gideren birini aramaya devam etmek, onu telefonu susturmaya iter; bir dahaki
 * gercek alarmi da kacirir.
 */
const STOPPED_STATUSES = ["acknowledged", "resolved"];

const REMINDER_KEY = "alarm_reminder_minutes";
const ESCALATE_KEY = "alarm_escalate_minutes";
const DEFAULT_REMINDER_MINUTES = 15;
const DEFAULT_ESCALATE_MINUTES = 45;

/**
 * Guvenlik kaynakli alarmlar (yangin/gaz panelinden gelen otomatik acil durdurma) icin
 * sure SABITTIR ve istasyon ayariyla degistirilemez: bir yangin alarminin yukseltme
 * saatini 6 saate cekmek isletmeye birakilabilecek bir tercih degildir.
 */
const SAFETY_ALARM_TYPES = new Set(["emergency_stop"]);
const SAFETY_REMINDER_MINUTES = 3;
const SAFETY_ESCALATE_MINUTES = 10;

export interface AlarmEscalationSettings {
  reminderMinutes: number;
  escalateMinutes: number;
}

function readNumberSetting(stationId: number, key: string, fallback: number): number {
  const raw = getSetting(stationId, key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getEscalationSettings(stationId: number): AlarmEscalationSettings {
  return {
    reminderMinutes: readNumberSetting(stationId, REMINDER_KEY, DEFAULT_REMINDER_MINUTES),
    escalateMinutes: readNumberSetting(stationId, ESCALATE_KEY, DEFAULT_ESCALATE_MINUTES),
  };
}

export class AlarmEscalationError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export function updateEscalationSettings(
  stationId: number,
  input: { reminderMinutes?: number; escalateMinutes?: number },
  actor: UserRow
): AlarmEscalationSettings {
  const next = { ...getEscalationSettings(stationId), ...input };
  if (!Number.isFinite(next.reminderMinutes) || next.reminderMinutes < 1 || next.reminderMinutes > 1440) {
    throw new AlarmEscalationError("Hatirlatma suresi 1 ile 1440 dakika arasinda olmalidir.", 400);
  }
  if (!Number.isFinite(next.escalateMinutes) || next.escalateMinutes < 1 || next.escalateMinutes > 1440) {
    throw new AlarmEscalationError("Yukseltme suresi 1 ile 1440 dakika arasinda olmalidir.", 400);
  }
  // Yukseltme hatirlatmadan once gelirse asamalar sirasini kaybeder ve alarm dogrudan
  // ust kademeye ziplar - bu, istasyonun kendi ekibine haber verme sansini elinden alir.
  if (next.escalateMinutes <= next.reminderMinutes) {
    throw new AlarmEscalationError("Yukseltme suresi, hatirlatma suresinden uzun olmalidir.", 400);
  }

  if (input.reminderMinutes !== undefined) setSetting(stationId, REMINDER_KEY, String(input.reminderMinutes), actor);
  if (input.escalateMinutes !== undefined) setSetting(stationId, ESCALATE_KEY, String(input.escalateMinutes), actor);
  return getEscalationSettings(stationId);
}

/** Bu alarm turu icin gecerli sureler (dakika). */
export function thresholdsFor(alarm: Pick<AlarmRow, "station_id" | "type">): AlarmEscalationSettings {
  if (SAFETY_ALARM_TYPES.has(alarm.type)) {
    return { reminderMinutes: SAFETY_REMINDER_MINUTES, escalateMinutes: SAFETY_ESCALATE_MINUTES };
  }
  return getEscalationSettings(alarm.station_id);
}

/**
 * Bir sonraki asamaya gecme zamani geldi mi?
 *
 * Sayac son bildirimden degil ALARMIN OLUSMASINDAN itibaren isler: bildirim gecikmeli
 * gonderilse bile (kuyruk birikmis olabilir) yukseltme takvimi kaymaz.
 */
export function nextLevelFor(alarm: AlarmRow, now: number): number | null {
  if (alarm.severity !== "critical") return null;
  if (STOPPED_STATUSES.includes(alarm.status)) return null;
  if (alarm.escalation_level >= 2) return null; // sinir: daha fazla tekrar yok

  const ageMinutes = (now - new Date(alarm.created_at).getTime()) / 60000;
  const t = thresholdsFor(alarm);

  if (alarm.escalation_level < 2 && ageMinutes >= t.escalateMinutes) return 2;
  if (alarm.escalation_level < 1 && ageMinutes >= t.reminderMinutes) return 1;
  return null;
}

export interface Recipient {
  email: string | null;
  phone: string | null;
  notifyEmail: boolean;
  notifySms: boolean;
  label: string;
}

/** Istasyonun kendi ekibi: bildirim tercihi acik admin/operator kullanicilari. */
function stationRecipients(stationId: number): Recipient[] {
  return db
    .prepare<[number], UserRow>(
      `SELECT u.* FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.station_id = ? AND u.active = 1 AND r.name IN ('admin', 'operator')`
    )
    .all(stationId)
    .map((u) => ({
      email: u.email,
      phone: u.phone,
      notifyEmail: !!u.notify_email,
      notifySms: !!u.notify_sms,
      label: u.display_name ?? u.username,
    }));
}

/**
 * Ust kademe: istasyonun bagli oldugu dagitim sirketinin yoneticileri ve platform
 * yoneticileri. Istasyonun kendi ekibi cevap vermiyorsa haberi almasi gereken kisiler
 * bunlardir - zincirin bir ust halkasi.
 */
function escalationRecipients(station: StationRow): Recipient[] {
  const rows = db
    .prepare<[number | null], UserRow>(
      `SELECT u.* FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.active = 1
         AND (r.name = 'super_admin' OR (r.name = 'tenant_admin' AND u.tenant_id IS NOT NULL AND u.tenant_id = ?))`
    )
    .all(station.tenant_id);
  return rows.map((u) => ({
    email: u.email,
    phone: u.phone,
    notifyEmail: !!u.notify_email,
    notifySms: !!u.notify_sms,
    label: u.display_name ?? u.username,
  }));
}

function minutesSince(iso: string, now: number): number {
  return Math.floor((now - new Date(iso).getTime()) / 60000);
}

/**
 * Bu asamada kimin haberdar edilecegi. Ayri bir fonksiyon olmasinin sebebi test
 * edilebilirlik: "yukseltmede dagitim sirketi yoneticisi de bilgilendiriliyor mu?"
 * sorusu, kuyruktan ve e-posta saglayicisindan bagimsiz olarak dogrulanabilmeli.
 */
export function recipientsForLevel(alarm: Pick<AlarmRow, "station_id">, level: number): Recipient[] {
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(alarm.station_id);
  if (!station) return [];
  // Yukseltmede istasyon ekibi de listede kalir: haberi almayi biraktiklari icin degil,
  // cevap veremedikleri icin yukseltiyoruz.
  return level >= 2 ? [...stationRecipients(alarm.station_id), ...escalationRecipients(station)] : stationRecipients(alarm.station_id);
}

async function notify(alarm: AlarmRow, level: number, now: number): Promise<void> {
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(alarm.station_id);
  if (!station) return;

  const age = minutesSince(alarm.created_at, now);
  const recipients = recipientsForLevel(alarm, level);

  const prefix = level >= 2 ? "[YUKSELTILDI]" : "[HATIRLATMA]";
  const subject = `${prefix} KRITIK ALARM - ${station.name}`;
  const text =
    `${station.name} istasyonundaki kritik alarm ${age} dakikadir CEVAPLANMADI:\n\n${alarm.message}\n\n` +
    (level >= 2
      ? "Istasyon ekibinden yanit alinamadigi icin ust kademeye iletilmistir.\n\n"
      : "") +
    `Alarm zamani: ${new Date(alarm.created_at).toLocaleString("tr-TR")}\n` +
    "Alarmi Alarm Merkezi'nden onaylayin; onaylanana kadar hatirlatma gonderilmeye devam eder.";

  // Ayni kisi hem istasyon ekibinde hem ust kademede olabilir (ör. tek kisilik isletme);
  // ayni alarm icin iki kez mesaj gondermek guveni azaltir.
  const seen = new Set<string>();
  const tasks: Promise<unknown>[] = [];
  for (const r of recipients) {
    if (r.notifyEmail && r.email && !seen.has(`e:${r.email}`)) {
      seen.add(`e:${r.email}`);
      tasks.push(sendEmail(r.email, subject, text));
    }
    if (r.notifySms && r.phone && !seen.has(`s:${r.phone}`)) {
      seen.add(`s:${r.phone}`);
      tasks.push(sendSms(r.phone, `${subject}: ${alarm.message}`));
    }
  }
  // E-posta/SMS'e EK olarak - webhook da hatirlatma/yukseltme olayini gorsun,
  // aksi halde SIEM/ops tarafi "cevapsiz kaldi" bilgisini hic almazdi.
  tasks.push(dispatchAlarmWebhook(alarm.station_id, station.name, alarm, level >= 2 ? "critical_alarm_escalated" : "critical_alarm_reminder"));
  await Promise.all(tasks);
}

registerWriteQueueHandler("alarm_escalation_notification", async (payload) => {
  const p = payload as { alarm: AlarmRow; level: number; at: number };
  await notify(p.alarm, p.level, p.at);
});

export interface EscalationSweepResult {
  reminded: number;
  escalated: number;
}

/**
 * Periyodik tarama (bkz. index.ts). Yukseltme seviyesi bildirim KUYRUGA YAZILMADAN
 * ONCE degil, yazildiktan hemen sonra guncellenir ve ikisi ayni turda yapilir; boylece
 * bir sonraki tur ayni alarmi tekrar ele almaz. Kuyruk kaydi dayanikli oldugu icin
 * (bkz. writeQueueService.ts) bildirim sunucu coksun/saglayici erisilemez olsun
 * kaybolmaz, tekrar denenir.
 */
export function sweepAlarmEscalations(now = Date.now()): EscalationSweepResult {
  const result: EscalationSweepResult = { reminded: 0, escalated: 0 };

  const candidates = db
    .prepare<[], AlarmRow>(
      "SELECT * FROM alarms WHERE severity = 'critical' AND status = 'active' AND escalation_level < 2"
    )
    .all();

  for (const alarm of candidates) {
    const level = nextLevelFor(alarm, now);
    if (level === null) continue;

    try {
      enqueueWrite("alarm_escalation_notification", { alarm, level, at: now });
      db.prepare("UPDATE alarms SET escalation_level = ?, last_notified_at = ? WHERE id = ?").run(
        level,
        new Date(now).toISOString(),
        alarm.id
      );
      if (level >= 2) result.escalated++;
      else result.reminded++;
    } catch (err) {
      logger.error({ err, alarmId: alarm.id, level }, "Alarm yukseltme bildirimi kuyruga yazilamadi.");
    }
  }

  return result;
}
