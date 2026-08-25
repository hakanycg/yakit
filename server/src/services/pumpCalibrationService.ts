import { db } from "../db/index.js";
import type { FuelType, PumpCalibrationRow, PumpRow, UserRow } from "../db/types.js";
import { createAlarm } from "./alarmService.js";
import { logger } from "../utils/logger.js";

/**
 * Pompa kalibrasyon (ayar) testi ve damga takibi.
 *
 * Bakim kayitlari serbest metindi; sayac hatasi, tolerans kontrolu ve damga gecerlilik
 * tarihi hicbir yerde tutulmuyordu. Oysa ayari kaymis bir pompa:
 *
 *  - YASA DISIDIR: akaryakit sayaclari periyodik muayeneye ve damgaya tabidir.
 *  - HER DOLUMDA CALAR: ya musteriden (pompa fazla gosteriyorsa) ya isletmeden (eksik).
 *  - YANLIS YERE BAKTIRIR: yakit sapma takibinde (fuelVarianceService.ts) aciklanamayan
 *    bir kayip olarak gorunur ve operator olmayan bir sizintiyi aramaya baslar. Teslimat
 *    kabul farkiyla (deliveryVarianceService.ts) tam olarak ayni desen: kaybi kaynaginda
 *    yakalamazsan, kaynagi belirsiz bir sapmaya donusur.
 *
 * Test yontemi: bilinen hacimli bir ayar kabina (prover) dolum yapilir, kabin gercek
 * hacmi ile pompa sayacinin gosterdigi karsilastirilir.
 */

/**
 * Azami kabul edilebilir hata: ±%0.5.
 *
 * Bu bir ISLETME TERCIHI DEGIL, yasal bir sinirdir - bu yuzden istasyon ayariyla
 * degistirilemez (ayni gerekce: guvenlik alarmlarinin yukseltme suresi). Gecerli
 * mevzuattaki guncel degeri kendi muayene kurulusunuzla teyit edin; degisirse burasi
 * tek noktadan guncellenir.
 */
export const MAX_PERMISSIBLE_ERROR_PCT = 0.5;

/** Damganin bitisine bu kadar kala uyari verilir - randevu almak icin makul bir sure. */
const SEAL_WARNING_DAYS = 30;

export class PumpCalibrationError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface CalibrationInput {
  fuelType: FuelType;
  /** Ayar kabinin gercek hacmi. */
  referenceLiters: number;
  /** Pompa sayacinin ayni test icin gosterdigi miktar. */
  meteredLiters: number;
  sealValidUntil?: string | null;
  sealReference?: string | null;
  note?: string | null;
}

export interface CalibrationEvaluation {
  errorLiters: number;
  errorPct: number;
  withinTolerance: boolean;
  /** Bu hatayla pompadan gecen her 1000 litrede olusan fark - aritmetik, tahmin degil. */
  litersPerThousand: number;
}

/**
 * Hatayi AYAR KABINA (gercek hacme) gore hesaplar.
 *
 * Sayac okumasina bolmek yanlis olurdu: hatanin buyuklugu, gercekte ne kadar yakit
 * verildigine gore anlamlidir - pompanin kendi (hatali) rakamina gore degil.
 */
export function evaluateCalibration(referenceLiters: number, meteredLiters: number): CalibrationEvaluation {
  if (!(referenceLiters > 0)) throw new PumpCalibrationError("Ayar kabi hacmi sifirdan buyuk olmalidir.", 400);
  if (!(meteredLiters >= 0)) throw new PumpCalibrationError("Sayac okumasi negatif olamaz.", 400);

  const errorLiters = round3(meteredLiters - referenceLiters);
  const errorPct = round3((errorLiters / referenceLiters) * 100);

  return {
    errorLiters,
    errorPct,
    withinTolerance: Math.abs(errorPct) <= MAX_PERMISSIBLE_ERROR_PCT,
    litersPerThousand: round2((errorPct / 100) * 1000),
  };
}

function getPump(stationId: number, pumpId: number): PumpRow {
  const pump = db
    .prepare<[number, number], PumpRow>("SELECT * FROM pumps WHERE id = ? AND station_id = ?")
    .get(pumpId, stationId);
  // Erisilemeyen pompa ile var olmayan pompa ayni cevabi dondurur.
  if (!pump) throw new PumpCalibrationError("Pompa bulunamadi.", 404);
  return pump;
}

export function listCalibrations(stationId: number, pumpId: number): (PumpCalibrationRow & { username: string | null })[] {
  getPump(stationId, pumpId);
  return db
    .prepare<[number], PumpCalibrationRow & { username: string | null }>(
      `SELECT c.*, u.username AS username
       FROM pump_calibrations c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.pump_id = ? ORDER BY c.tested_at DESC`
    )
    .all(pumpId);
}

/**
 * Kalibrasyon testini kaydeder. Tolerans disindaysa KRITIK alarm uretir: pompa hem yasa
 * disi hale gelmistir hem de her dolumda taraflardan birinin aleyhine calismaktadir.
 */
export function recordCalibration(
  stationId: number,
  pumpId: number,
  input: CalibrationInput,
  actor: UserRow
): PumpCalibrationRow & { evaluation: CalibrationEvaluation } {
  const pump = getPump(stationId, pumpId);
  const evaluation = evaluateCalibration(input.referenceLiters, input.meteredLiters);

  const result = db
    .prepare(
      `INSERT INTO pump_calibrations
         (station_id, pump_id, fuel_type, reference_liters, metered_liters, error_liters, error_pct,
          within_tolerance, seal_valid_until, seal_reference, note, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      stationId,
      pumpId,
      input.fuelType,
      input.referenceLiters,
      input.meteredLiters,
      evaluation.errorLiters,
      evaluation.errorPct,
      evaluation.withinTolerance ? 1 : 0,
      input.sealValidUntil ?? null,
      input.sealReference ?? null,
      input.note ?? null,
      actor.id
    );

  if (!evaluation.withinTolerance) {
    const direction = evaluation.errorPct > 0 ? "FAZLA (musteri aleyhine)" : "EKSIK (isletme aleyhine)";
    createAlarm({
      stationId,
      pumpId,
      type: "pump_calibration_out_of_tolerance",
      severity: "critical",
      message:
        `Pompa ${pump.number} (${input.fuelType}) ayar testinde tolerans DISINDA: ` +
        `${input.referenceLiters} L'lik testte sayac ${input.meteredLiters} L gosterdi ` +
        `(%${evaluation.errorPct}, ${direction}; yasal sinir ±%${MAX_PERMISSIBLE_ERROR_PCT}). ` +
        `Her 1000 L'de ${evaluation.litersPerThousand} L fark olusur. Pompa muayeneye alinmalidir.`,
    });
  }

  const row = db
    .prepare<[number], PumpCalibrationRow>("SELECT * FROM pump_calibrations WHERE id = ?")
    .get(result.lastInsertRowid as number)!;
  return { ...row, evaluation };
}

export interface PumpCalibrationStatus {
  pumpId: number;
  pumpNumber: number;
  lastTestedAt: string | null;
  lastErrorPct: number | null;
  withinTolerance: boolean | null;
  sealValidUntil: string | null;
  /** Damganin bitisine kalan gun. Negatif: suresi dolmus. Tarih yoksa null. */
  sealDaysRemaining: number | null;
  sealStatus: "valid" | "expiring" | "expired" | "unknown";
}

function daysUntil(iso: string, now: number): number {
  return Math.floor((new Date(iso).getTime() - now) / 86400000);
}

function sealStatusFor(daysRemaining: number | null): PumpCalibrationStatus["sealStatus"] {
  if (daysRemaining === null) return "unknown";
  if (daysRemaining < 0) return "expired";
  return daysRemaining <= SEAL_WARNING_DAYS ? "expiring" : "valid";
}

/**
 * Istasyondaki her pompanin son kalibrasyon durumu.
 *
 * Her pompa icin YALNIZCA en son test dikkate alinir: gecmis testler kayittadir ama
 * "pompa su anda yasal mi" sorusunun cevabi en sonuncusudur.
 */
export function getStationCalibrationStatus(stationId: number, now = Date.now()): PumpCalibrationStatus[] {
  return db
    .prepare<[number], { id: number; number: number }>("SELECT id, number FROM pumps WHERE station_id = ? ORDER BY number")
    .all(stationId)
    .map((pump) => {
      const last = db
        .prepare<[number], PumpCalibrationRow>("SELECT * FROM pump_calibrations WHERE pump_id = ? ORDER BY tested_at DESC LIMIT 1")
        .get(pump.id);
      const sealDaysRemaining = last?.seal_valid_until ? daysUntil(last.seal_valid_until, now) : null;

      return {
        pumpId: pump.id,
        pumpNumber: pump.number,
        lastTestedAt: last?.tested_at ?? null,
        lastErrorPct: last?.error_pct ?? null,
        withinTolerance: last ? last.within_tolerance === 1 : null,
        sealValidUntil: last?.seal_valid_until ?? null,
        sealDaysRemaining,
        sealStatus: sealStatusFor(sealDaysRemaining),
      };
    });
}

const SEAL_ALARM_TYPE = "pump_seal_expiring";

/**
 * Damgasi dolan/dolmak uzere olan pompalar icin alarm uretir (bkz. index.ts).
 *
 * Ayni pompa icin acik bir alarm varsa yenisi acilmaz; damga yenilendiginde (yeni bir
 * kalibrasyon kaydi girilince) alarm kendiliginden cozulur - operatorun elle temizlemesi
 * gereken bir kalinti birakilmaz.
 */
export function checkExpiringSeals(now = Date.now()): { warned: number; expired: number } {
  const result = { warned: 0, expired: 0 };
  const stations = db.prepare<[], { id: number }>("SELECT id FROM stations WHERE active = 1").all();

  for (const station of stations) {
    for (const status of getStationCalibrationStatus(station.id, now)) {
      const existing = db
        .prepare<[number, string, number], { id: number }>(
          "SELECT id FROM alarms WHERE station_id = ? AND type = ? AND pump_id = ? AND status != 'resolved' LIMIT 1"
        )
        .get(station.id, SEAL_ALARM_TYPE, status.pumpId);

      // "unknown" alarm URETMEZ: damga tarihi hic girilmemis olabilir ve bunu ihlal gibi
      // gostermek, veriyi girmemis her istasyonu alarma bogardi.
      if (status.sealStatus === "valid" || status.sealStatus === "unknown") {
        if (existing) {
          db.prepare("UPDATE alarms SET status = 'resolved', resolved_at = ? WHERE id = ?").run(new Date(now).toISOString(), existing.id);
        }
        continue;
      }
      if (existing) continue;

      const expired = status.sealStatus === "expired";
      try {
        createAlarm({
          stationId: station.id,
          pumpId: status.pumpId,
          type: SEAL_ALARM_TYPE,
          // Suresi dolmus damgayla calismak yasa disidir - uyari degil kritik.
          severity: expired ? "critical" : "warning",
          message: expired
            ? `Pompa ${status.pumpNumber} damgasinin suresi ${Math.abs(status.sealDaysRemaining!)} gun once DOLDU (${status.sealValidUntil?.slice(0, 10)}). Suresi dolmus damgayla satis yapilamaz.`
            : `Pompa ${status.pumpNumber} damgasinin suresi ${status.sealDaysRemaining} gun sonra doluyor (${status.sealValidUntil?.slice(0, 10)}). Periyodik muayene randevusu alin.`,
        });
        if (expired) result.expired++;
        else result.warned++;
      } catch (err) {
        logger.error({ err, pumpId: status.pumpId }, "Pompa damga alarmi uretilemedi.");
      }
    }
  }

  return result;
}

export function serializeCalibration(c: PumpCalibrationRow & { username?: string | null }) {
  return {
    id: c.id,
    pumpId: c.pump_id,
    fuelType: c.fuel_type,
    referenceLiters: c.reference_liters,
    meteredLiters: c.metered_liters,
    errorLiters: c.error_liters,
    errorPct: c.error_pct,
    withinTolerance: c.within_tolerance === 1,
    sealValidUntil: c.seal_valid_until,
    sealReference: c.seal_reference,
    note: c.note,
    testedAt: c.tested_at,
    username: c.username ?? null,
  };
}
