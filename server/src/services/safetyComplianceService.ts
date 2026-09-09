import { db } from "../db/index.js";
import type { SafetyComplianceRecordRow, UserRow } from "../db/types.js";
import { createAlarm } from "./alarmService.js";
import { logger } from "../utils/logger.js";

/**
 * TS 12820'nin pompa kalibrasyonu/damgasi (bkz. pumpCalibrationService.ts) DISINDAKI
 * periyodik emniyet kontrolu/sertifika gerektiren maddeleri.
 *
 * Her kalem icin AYNI soru: "bu kontrol/egitim en son ne zaman yapildi, sirada ne var,
 * suresi gecen var mi" - pompa kalibrasyonuyla birebir ayni desen, ama pompa
 * bagimsiz (istasyon geneli) ve BIRDEN FAZLA sabit kalem tipi icin.
 *
 * intervalMonths degerleri iki farkli kaynaktan geliyor - bu ayrim asagida her
 * kalemde ayrica belirtilir:
 *  - standarttan DOGRUDAN alinan sayisal bir sinir (ör. sondurucu: "en az 6 ayda bir",
 *    katodik koruma: "yilda en az bir") - bunlar YASAL bir taban, kucultulemez ama
 *    admin daha sik kontrol icin kisaltabilir (guvenlik payi eklemek serbest).
 *  - standardin yalnizca "periyodik" dedigi ama sayi vermedigi maddeler (topraklama,
 *    elektrik tesisati muayenesi, personel egitimi) - buradaki 12 ay ONERI'dir, TSE'nin
 *    kendisi bir sayi vermiyor; admin istasyonunun kendi risk degerlendirmesine gore
 *    degistirebilir.
 */

export interface SafetyComplianceItemMeta {
  type: string;
  label: string;
  /** TS 12820'deki ilgili madde - kullanicIya kaynak gostermek icin. */
  standardClause: string;
  defaultIntervalMonths: number;
  /** true: standart sayiyi DOGRUDAN veriyor (yasal taban). false: standart yalnizca "periyodik" diyor, sayi oneridir. */
  intervalIsFromStandard: boolean;
}

export const SAFETY_COMPLIANCE_ITEMS = [
  {
    type: "fire_extinguisher",
    label: "Yangın söndürücü kontrolü",
    standardClause: "TS 12820 madde 4.12",
    defaultIntervalMonths: 6,
    intervalIsFromStandard: true,
  },
  {
    type: "lightning_protection",
    label: "Paratoner / yangından korunma belgesi",
    standardClause: "TS 12820 madde 4.12.3",
    defaultIntervalMonths: 12,
    intervalIsFromStandard: false,
  },
  {
    type: "cathodic_protection",
    label: "Katodik koruma kontrolü",
    standardClause: "TS 12820 madde 4.2.5.1",
    defaultIntervalMonths: 12,
    intervalIsFromStandard: true,
  },
  {
    type: "tank_grounding",
    label: "Tank topraklama denetimi",
    standardClause: "TS 12820 madde 4.2.5.3 / 4.15.16.3",
    defaultIntervalMonths: 12,
    intervalIsFromStandard: false,
  },
  {
    type: "electrical_inspection",
    label: "Tehlikeli bölge elektrik tesisatı muayenesi",
    standardClause: "TS 12820 madde 4.9.1 / TS EN 60079-17",
    defaultIntervalMonths: 12,
    intervalIsFromStandard: false,
  },
  {
    type: "staff_safety_training",
    label: "Personel sağlık/emniyet/yangın eğitimi ve tahliye tatbikatı",
    standardClause: "TS 12820 madde 4.12.4",
    defaultIntervalMonths: 12,
    intervalIsFromStandard: false,
  },
  {
    type: "dispenser_shutoff_valve",
    label: "Dağıtım birimi otomatik kapama vanası testi",
    standardClause: "TS 12820 madde 4.5.2.5",
    defaultIntervalMonths: 12,
    intervalIsFromStandard: true,
  },
  {
    type: "remote_pump_leak_detector",
    label: "Uzaktan pompalama sistemi kaçak dedektörü testi (varsa)",
    standardClause: "TS 12820 madde 4.5.2.6",
    defaultIntervalMonths: 12,
    intervalIsFromStandard: true,
  },
] as const satisfies readonly SafetyComplianceItemMeta[];

export type SafetyComplianceItemType = (typeof SAFETY_COMPLIANCE_ITEMS)[number]["type"];

const ITEM_BY_TYPE = new Map<string, SafetyComplianceItemMeta>(SAFETY_COMPLIANCE_ITEMS.map((i) => [i.type, i]));

function getItemMeta(itemType: string): SafetyComplianceItemMeta {
  const meta = ITEM_BY_TYPE.get(itemType);
  if (!meta) throw new SafetyComplianceError("Gecersiz emniyet kontrol kalemi.", 400);
  return meta;
}

export class SafetyComplianceError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** Vadenin bitisine bu kadar kala uyari verilir - pompa damgasindaki (30 gun) esikle ayni. */
const DUE_WARNING_DAYS = 30;

function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

export interface RecordComplianceInput {
  itemType: SafetyComplianceItemType;
  /** Kontrolun/egitimin fiilen yapildigi tarih (gun sonu kabul edilir). */
  completedAt: string;
  /** Belirtilmezse kalemin varsayilan araligi kullanilir. */
  intervalMonths?: number;
  reference?: string | null;
  note?: string | null;
}

export function recordCompliance(stationId: number, input: RecordComplianceInput, actor: UserRow): SafetyComplianceRecordRow {
  const meta = getItemMeta(input.itemType);
  const intervalMonths = input.intervalMonths ?? meta.defaultIntervalMonths;
  if (!(intervalMonths > 0) || intervalMonths > 120) {
    throw new SafetyComplianceError("Kontrol araligi 1-120 ay arasinda olmalidir.", 400);
  }

  const nextDueAt = addMonths(input.completedAt, intervalMonths);
  const result = db
    .prepare(
      `INSERT INTO safety_compliance_records
         (station_id, item_type, completed_at, next_due_at, interval_months, reference, note, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(stationId, input.itemType, input.completedAt, nextDueAt, intervalMonths, input.reference ?? null, input.note ?? null, actor.id);

  // Bu kalem icin acik bir vade alarmi varsa hemen coz - kayit girildigi an "guncel" hale gelir,
  // operatorun ayrica bir alarmi elle temizlemesi gerekmez (bkz. checkExpiringCompliance).
  resolveAlarmFor(stationId, input.itemType);

  return db.prepare<[number], SafetyComplianceRecordRow>("SELECT * FROM safety_compliance_records WHERE id = ?").get(
    result.lastInsertRowid as number
  )!;
}

export function listCompliance(stationId: number, itemType: SafetyComplianceItemType): SafetyComplianceRecordRow[] {
  getItemMeta(itemType);
  return db
    .prepare<[number, string], SafetyComplianceRecordRow>(
      "SELECT * FROM safety_compliance_records WHERE station_id = ? AND item_type = ? ORDER BY completed_at DESC"
    )
    .all(stationId, itemType);
}

export interface SafetyComplianceStatus {
  itemType: SafetyComplianceItemType;
  label: string;
  standardClause: string;
  lastCompletedAt: string | null;
  nextDueAt: string | null;
  /** Vadeye kalan gun. Negatif: suresi dolmus. Hic kayit yoksa null. */
  daysRemaining: number | null;
  status: "valid" | "expiring" | "expired" | "unknown";
}

function daysUntil(iso: string, now: number): number {
  return Math.floor((new Date(iso).getTime() - now) / 86400000);
}

function statusFor(daysRemaining: number | null): SafetyComplianceStatus["status"] {
  if (daysRemaining === null) return "unknown";
  if (daysRemaining < 0) return "expired";
  return daysRemaining <= DUE_WARNING_DAYS ? "expiring" : "valid";
}

/** Istasyondaki HER kalem icin en son kaydin durumu - hic kaydi olmayan kalemler de "unknown" olarak listelenir. */
export function getStationComplianceStatus(stationId: number, now = Date.now()): SafetyComplianceStatus[] {
  return SAFETY_COMPLIANCE_ITEMS.map((meta) => {
    const last = db
      .prepare<[number, string], SafetyComplianceRecordRow>(
        "SELECT * FROM safety_compliance_records WHERE station_id = ? AND item_type = ? ORDER BY completed_at DESC LIMIT 1"
      )
      .get(stationId, meta.type);
    const daysRemaining = last ? daysUntil(last.next_due_at, now) : null;

    return {
      itemType: meta.type,
      label: meta.label,
      standardClause: meta.standardClause,
      lastCompletedAt: last?.completed_at ?? null,
      nextDueAt: last?.next_due_at ?? null,
      daysRemaining,
      status: statusFor(daysRemaining),
    };
  });
}

const ALARM_TYPE_PREFIX = "safety_compliance_";

function alarmType(itemType: string): string {
  return `${ALARM_TYPE_PREFIX}${itemType}`;
}

function resolveAlarmFor(stationId: number, itemType: string): void {
  const existing = db
    .prepare<[number, string], { id: number }>("SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved' LIMIT 1")
    .get(stationId, alarmType(itemType));
  if (existing) {
    db.prepare("UPDATE alarms SET status = 'resolved', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
  }
}

/**
 * Suresi dolan/dolmak uzere olan emniyet kontrolleri icin alarm uretir (bkz. index.ts).
 *
 * Pompa damga taramasiyla (checkExpiringSeals) AYNI ilke: "unknown" (hic kayit
 * girilmemis) durum icin alarm URETILMEZ - aksi halde ozelligi henuz kullanmaya
 * baslamamis her istasyon alarma bogulurdu. Ayni kalem icin acik alarm varsa
 * yenisi acilmaz; kayit yenilenince (recordCompliance) alarm kendiliginden cozulur.
 */
export function checkExpiringCompliance(now = Date.now()): { warned: number; expired: number } {
  const result = { warned: 0, expired: 0 };
  const stations = db.prepare<[], { id: number }>("SELECT id FROM stations WHERE active = 1").all();

  for (const station of stations) {
    for (const status of getStationComplianceStatus(station.id, now)) {
      if (status.status === "valid" || status.status === "unknown") {
        resolveAlarmFor(station.id, status.itemType);
        continue;
      }

      const existing = db
        .prepare<[number, string], { id: number }>(
          "SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved' LIMIT 1"
        )
        .get(station.id, alarmType(status.itemType));
      if (existing) continue;

      const expired = status.status === "expired";
      try {
        createAlarm({
          stationId: station.id,
          type: alarmType(status.itemType),
          severity: expired ? "critical" : "warning",
          message: expired
            ? `${status.label} (${status.standardClause}) vadesi ${Math.abs(status.daysRemaining!)} gun once DOLDU (${status.nextDueAt?.slice(0, 10)}). Kontrol/egitim yenilenmelidir.`
            : `${status.label} (${status.standardClause}) vadesi ${status.daysRemaining} gun sonra doluyor (${status.nextDueAt?.slice(0, 10)}).`,
        });
        if (expired) result.expired++;
        else result.warned++;
      } catch (err) {
        logger.error({ err, stationId: station.id, itemType: status.itemType }, "Emniyet uyum alarmi uretilemedi.");
      }
    }
  }

  return result;
}

export function serializeComplianceRecord(r: SafetyComplianceRecordRow) {
  return {
    id: r.id,
    itemType: r.item_type,
    completedAt: r.completed_at,
    nextDueAt: r.next_due_at,
    intervalMonths: r.interval_months,
    reference: r.reference,
    note: r.note,
    createdAt: r.created_at,
  };
}
