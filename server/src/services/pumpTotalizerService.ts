import { db } from "../db/index.js";
import type { FuelType, PumpRow, PumpTotalizerReadingRow, UserRow } from "../db/types.js";
import { createAlarm } from "./alarmService.js";
import { getSetting, setSetting } from "./settingsStore.js";

/**
 * Pompa sayaci (totalizator) mutabakati - stok kontrolunun POMPA ayagi.
 *
 * Tank tarafi zaten vardi (fiziksel olcum <-> kayit stogu, bkz. fuelVarianceService).
 * Ama tank olcumu tek basina kaybin NEREDE oldugunu soylemez: yakit tanktan mi sizdi,
 * yoksa pompadan kayit disi mi akitildi? Bu ikisi tamamen farkli iki sorundur ve
 * tamamen farkli iki mudahale gerektirir.
 *
 * Sayac okumasi bu ayrimi yapar:
 *
 *   tank 1000 dustu, pompa 1000 satti, sistem 1000 kaydetti -> temiz
 *   tank 1000 dustu, pompa 1000 satti, sistem  800 kaydetti -> 200 L KAYIT DISI CEKIM
 *   tank 1000 dustu, pompa  800 satti, sistem  800 kaydetti -> 200 L TANKTAN GITTI
 *
 * KALIBRASYONDAN FARKLIDIR (bkz. pumpCalibrationService): kalibrasyon sayacin DOGRU
 * olcup olcmedigini ayar kabiyla test eder. Buradaki kontrol sayacin saydigi ile
 * sistemin kaydettigini karsilastirir - sayac kusursuz calissa bile kayit disi bir
 * cekim buradan gorunur.
 *
 * Bu servis HICBIR SEYI DUZELTMEZ. Tank olcumu stogu olcume esitler cunku fiziksel
 * olcum daha guvenilir bir gercektir; sayac ise bir envanter degil bir SAYACtir,
 * duzeltilecek bir sey yoktur. Yalnizca raporlar ve alarm uretir.
 */

/**
 * Sapmanin alarma donusmesi icin gereken oran esigi (dagitilan hacmin yuzdesi).
 * Tank esiginden dar tutuluyor: pompa sayaci yasal olarak +-%0,5 icinde calismak
 * zorundadir, dolayisiyla burada beklenen fark ~sifirdir.
 */
const DEFAULT_THRESHOLD_PCT = 0.5;
/** Oran asilsa bile bu litrenin altindaki farklar alarma donusmez (kucuk pencerelerde gurultu). */
const DEFAULT_MIN_LITERS = 20;

const THRESHOLD_PCT_KEY = "pump_totalizer_threshold_pct";
const MIN_LITERS_KEY = "pump_totalizer_min_liters";

export class PumpTotalizerError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface TotalizerSettings {
  thresholdPct: number;
  minLiters: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function readNumberSetting(stationId: number, key: string, fallback: number): number {
  const raw = getSetting(stationId, key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getTotalizerSettings(stationId: number): TotalizerSettings {
  return {
    thresholdPct: readNumberSetting(stationId, THRESHOLD_PCT_KEY, DEFAULT_THRESHOLD_PCT),
    minLiters: readNumberSetting(stationId, MIN_LITERS_KEY, DEFAULT_MIN_LITERS),
  };
}

export function updateTotalizerSettings(
  stationId: number,
  input: { thresholdPct?: number; minLiters?: number },
  actor: UserRow
): TotalizerSettings {
  if (input.thresholdPct !== undefined) {
    if (!Number.isFinite(input.thresholdPct) || input.thresholdPct < 0 || input.thresholdPct > 100) {
      throw new PumpTotalizerError("Sapma esigi 0 ile 100 arasinda bir yuzde olmalidir.", 400);
    }
    setSetting(stationId, THRESHOLD_PCT_KEY, String(input.thresholdPct), actor);
  }
  if (input.minLiters !== undefined) {
    if (!Number.isFinite(input.minLiters) || input.minLiters < 0) {
      throw new PumpTotalizerError("En dusuk sapma litresi negatif olamaz.", 400);
    }
    setSetting(stationId, MIN_LITERS_KEY, String(input.minLiters), actor);
  }
  return getTotalizerSettings(stationId);
}

function getPump(stationId: number, pumpId: number): PumpRow {
  const row = db.prepare<[number, number], PumpRow>("SELECT * FROM pumps WHERE id = ? AND station_id = ?").get(pumpId, stationId);
  if (!row) throw new PumpTotalizerError("Pompa bulunamadi.", 404);
  return row;
}

function getPreviousReading(stationId: number, pumpId: number, fuelType: FuelType): PumpTotalizerReadingRow | undefined {
  return db
    .prepare<[number, number, string], PumpTotalizerReadingRow>(
      `SELECT * FROM pump_totalizer_readings
        WHERE station_id = ? AND pump_id = ? AND fuel_type = ?
        ORDER BY measured_at DESC, id DESC LIMIT 1`
    )
    .get(stationId, pumpId, fuelType);
}

/**
 * Iki okuma arasinda SISTEME kaydedilen satis.
 *
 * Kaynak dogrudan transactions: stok hareketleri uzerinden gitmek ayni rakami bir
 * donusum daha uzerinden okumak olurdu ve "sistem ne kaydetti" sorusunun en dogrudan
 * cevabi islemin kendisidir. Yalnizca TAMAMLANMIS islemler sayilir - iptal edilmis
 * bir islemde yakit akmamistir.
 */
function recordedLiters(stationId: number, pumpId: number, fuelType: FuelType, since: string | null, until: string): number {
  const row = since
    ? db
        .prepare<[number, number, string, string, string], { total: number | null }>(
          `SELECT SUM(dispensed_liters) AS total FROM transactions
            WHERE station_id = ? AND pump_id = ? AND fuel_type = ? AND status = 'completed'
              AND completed_at > ? AND completed_at <= ?`
        )
        .get(stationId, pumpId, fuelType, since, until)
    : db
        .prepare<[number, number, string, string], { total: number | null }>(
          `SELECT SUM(dispensed_liters) AS total FROM transactions
            WHERE station_id = ? AND pump_id = ? AND fuel_type = ? AND status = 'completed'
              AND completed_at <= ?`
        )
        .get(stationId, pumpId, fuelType, until);
  return round2(row?.total ?? 0);
}

export interface RecordTotalizerInput {
  stationId: number;
  pumpId: number;
  fuelType: FuelType;
  totalizerLiters: number;
  measuredAt?: string;
  note?: string | null;
  actor: UserRow | null;
  /**
   * Sayac degistirildi/sifirlandi: bu okuma yeni bir BASLANGIC noktasidir. Eski sayacla
   * yeni sayacin farkini "kayip" saymak sacma olurdu, o yuzden sapma uretilmez.
   * Bilincli bir beyandir - geriye giden bir okumayi sessizce boyle yorumlamayiz.
   */
  meterReset?: boolean;
}

export interface RecordTotalizerResult {
  reading: PumpTotalizerReadingRow;
  alarmRaised: boolean;
}

export function recordTotalizerReading(input: RecordTotalizerInput): RecordTotalizerResult {
  const { stationId, pumpId, fuelType, totalizerLiters, actor } = input;
  if (!Number.isFinite(totalizerLiters) || totalizerLiters < 0) {
    throw new PumpTotalizerError("Sayac degeri negatif olamaz.", 400);
  }

  const pump = getPump(stationId, pumpId);
  const pumpFuels = JSON.parse(pump.fuel_types) as FuelType[];
  if (!pumpFuels.includes(fuelType)) {
    throw new PumpTotalizerError("Bu pompa bu yakit tipini vermiyor.", 400);
  }

  const measuredAt = input.measuredAt ?? new Date().toISOString();
  const previous = getPreviousReading(stationId, pumpId, fuelType);
  if (previous && measuredAt <= previous.measured_at) {
    throw new PumpTotalizerError("Okuma tarihi, bu pompadaki son okumadan sonra olmalidir.", 400);
  }

  const meterReset = !!input.meterReset;
  // Sayac GERI SAYMAZ. Onceki okumanin altina dusen bir deger ya sayac degisimidir ya
  // da yanlis giristir; ikisi de sessizce kabul edilemez - sessizce kabul edilseydi
  // negatif bir "dagitim" hesaplanir ve mutabakat sacmalardi.
  if (previous && !meterReset && totalizerLiters < previous.totalizer_liters) {
    throw new PumpTotalizerError(
      `Sayac degeri onceki okumadan (${previous.totalizer_liters} L) kucuk olamaz. ` +
        `Sayac degistirildiyse "sayac degisimi" olarak isaretleyin.`,
      400
    );
  }

  const isBaseline = !previous || meterReset;
  const dispensed = isBaseline ? 0 : round2(totalizerLiters - previous!.totalizer_liters);
  const recorded = isBaseline ? 0 : recordedLiters(stationId, pumpId, fuelType, previous!.measured_at, measuredAt);
  const varianceLiters = round2(dispensed - recorded);
  // Oran DAGITILAN hacme bolunur: 10.000 L'lik bir vardiyada 20 L fark tolerans icinde
  // sayilabilirken, 200 L'lik bir vardiyada ayni 20 L ciddi bir sorundur.
  const variancePct = dispensed > 0 ? round2((Math.abs(varianceLiters) / dispensed) * 100) : 0;

  const settings = getTotalizerSettings(stationId);
  const exceedsThreshold =
    !isBaseline && Math.abs(varianceLiters) >= settings.minLiters && variancePct >= settings.thresholdPct;

  const readingId = db
    .prepare(
      `INSERT INTO pump_totalizer_readings
         (station_id, pump_id, fuel_type, totalizer_liters, previous_reading_id, previous_totalizer_liters,
          dispensed_liters, recorded_liters, variance_liters, variance_pct, is_meter_reset, note, measured_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      stationId,
      pumpId,
      fuelType,
      totalizerLiters,
      previous?.id ?? null,
      previous?.totalizer_liters ?? null,
      dispensed,
      recorded,
      varianceLiters,
      variancePct,
      meterReset ? 1 : 0,
      input.note?.trim() || null,
      measuredAt,
      actor?.id ?? null
    ).lastInsertRowid as number;

  let alarmId: number | null = null;
  if (exceedsThreshold) {
    // Iki yon iki AYRI sorundur; mesaj hangisi oldugunu soylemeli ki personel dogru
    // yere baksin.
    const message =
      varianceLiters > 0
        ? `${pump.label} (${fuelType}) sayaci ${dispensed} L dagitmis ama sisteme ${recorded} L kaydedilmis: ` +
          `${varianceLiters} L KAYIT DISI CEKIM (dagitilanin %${variancePct}'i). Pompanin manuel/bypass ` +
          `calistirilip calistirilmadigini kontrol edin.`
        : `${pump.label} (${fuelType}) sisteme ${recorded} L kaydedilmis ama sayac yalnizca ${dispensed} L ` +
          `dagitmis: ${Math.abs(varianceLiters)} L FARK (dagitilanin %${variancePct}'i). Sayac arizasi ya da ` +
          `dagitilmadan tamamlanmis islem acisindan kontrol edin.`;
    const alarm = createAlarm({ stationId, pumpId, type: "pump_totalizer_variance", severity: "critical", message });
    alarmId = alarm.id;
    db.prepare("UPDATE pump_totalizer_readings SET alarm_id = ? WHERE id = ?").run(alarmId, readingId);
  }

  const reading = db
    .prepare<[number], PumpTotalizerReadingRow>("SELECT * FROM pump_totalizer_readings WHERE id = ?")
    .get(readingId)!;
  return { reading, alarmRaised: alarmId !== null };
}

export function listTotalizerReadings(
  stationId: number,
  filters: { pumpId?: number; limit?: number }
): (PumpTotalizerReadingRow & { username: string | null; pumpLabel: string })[] {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const params: (number | string)[] = [stationId];
  let where = "r.station_id = ?";
  if (filters.pumpId !== undefined) {
    where += " AND r.pump_id = ?";
    params.push(filters.pumpId);
  }
  params.push(limit);
  return db
    .prepare<(number | string)[], PumpTotalizerReadingRow & { username: string | null; pumpLabel: string }>(
      `SELECT r.*, u.username AS username, p.label AS pumpLabel
         FROM pump_totalizer_readings r
         LEFT JOIN users u ON u.id = r.user_id
         JOIN pumps p ON p.id = r.pump_id
        WHERE ${where}
        ORDER BY r.measured_at DESC, r.id DESC
        LIMIT ?`
    )
    .all(...params);
}

export interface TotalizerPumpStatus {
  pumpId: number;
  pumpLabel: string;
  fuelType: FuelType;
  lastTotalizerLiters: number | null;
  lastMeasuredAt: string | null;
  /** Son okumadan bu yana sisteme kaydedilen satis - bir sonraki okumada beklenen fark. */
  recordedSinceLiters: number;
  cumulativeVarianceLiters: number;
}

/**
 * Pompa/yakit basina son durum.
 *
 * Kumulatif sapma tek tek okumalardan daha cok sey soyler: tek bir okumadaki arti/eksi
 * salinim okuma hatasidir, SUREKLI ayni yonde biriken bir toplam ise sistematik bir
 * sorundur (ayni gerekce: fuelVarianceService.getVarianceSummary).
 */
export function getTotalizerStatus(stationId: number): TotalizerPumpStatus[] {
  const pumps = db.prepare<[number], PumpRow>("SELECT * FROM pumps WHERE station_id = ? ORDER BY number").all(stationId);
  const rows: TotalizerPumpStatus[] = [];

  for (const pump of pumps) {
    for (const fuelType of JSON.parse(pump.fuel_types) as FuelType[]) {
      const last = getPreviousReading(stationId, pump.id, fuelType);
      const cumulative = db
        .prepare<[number, number, string], { total: number | null }>(
          `SELECT SUM(variance_liters) AS total FROM pump_totalizer_readings
            WHERE station_id = ? AND pump_id = ? AND fuel_type = ?`
        )
        .get(stationId, pump.id, fuelType);

      rows.push({
        pumpId: pump.id,
        pumpLabel: pump.label,
        fuelType,
        lastTotalizerLiters: last?.totalizer_liters ?? null,
        lastMeasuredAt: last?.measured_at ?? null,
        recordedSinceLiters: recordedLiters(stationId, pump.id, fuelType, last?.measured_at ?? null, new Date().toISOString()),
        cumulativeVarianceLiters: round2(cumulative?.total ?? 0),
      });
    }
  }
  return rows;
}

export function serializeTotalizerReading(
  r: PumpTotalizerReadingRow & { username?: string | null; pumpLabel?: string }
) {
  return {
    id: r.id,
    pumpId: r.pump_id,
    pumpLabel: r.pumpLabel,
    fuelType: r.fuel_type,
    totalizerLiters: r.totalizer_liters,
    previousTotalizerLiters: r.previous_totalizer_liters,
    dispensedLiters: r.dispensed_liters,
    recordedLiters: r.recorded_liters,
    varianceLiters: r.variance_liters,
    variancePct: r.variance_pct,
    isMeterReset: !!r.is_meter_reset,
    alarmId: r.alarm_id,
    note: r.note,
    measuredAt: r.measured_at,
    username: r.username ?? null,
  };
}
