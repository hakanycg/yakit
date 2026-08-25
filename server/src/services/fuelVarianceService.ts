import { db } from "../db/index.js";
import type { FuelTankReadingRow, FuelType, UserRow } from "../db/types.js";
import { createAlarm } from "./alarmService.js";
import { adjustStock, FuelStockError, getTank } from "./fuelStockService.js";
import { getSetting, setSetting } from "./settingsStore.js";

/**
 * Yakit sapma (wetstock) takibi.
 *
 * Personelsiz istasyonda tanki gozle kontrol eden kimse olmadigindan sizinti,
 * ayari kaymis bir pompa veya kayit disi cekim ancak su karsilastirmayla
 * yakalanir: "kayitta 8.400 L olmali, fiziksel olcumde 8.180 L cikti".
 *
 * Sapma orani tank KAPASITESINE degil, onceki olcumden bu yana tanktan GECEN
 * hacme (satis + teslimat) bolunur. 50.000 L'lik bir dolasimda 200 L fark
 * sicaklik ve sayac toleransiyla aciklanabilirken, 2.000 L'lik dolasimda ayni
 * 200 L ciddi bir kayiptir; kapasiteye bolmek bu ayrimi tamamen kaybettirirdi.
 */

/** Sapmanin alarma donusmesi icin gereken oran esigi (hareket hacminin yuzdesi). */
const DEFAULT_THRESHOLD_PCT = 0.5;
/**
 * Oran esigi asilsa bile bu litrenin altindaki farklar alarma donusmez. Dusuk
 * hacimli gunlerde (orn. 100 L satis) birkac litrelik olcum hatasi yuzde olarak
 * buyuk gorunur; mutlak taban bu yanlis alarmlari eler.
 */
const DEFAULT_MIN_LITERS = 50;

const THRESHOLD_PCT_KEY = "fuel_variance_threshold_pct";
const MIN_LITERS_KEY = "fuel_variance_min_liters";

export interface VarianceSettings {
  thresholdPct: number;
  minLiters: number;
}

function readNumberSetting(stationId: number, key: string, fallback: number): number {
  const raw = getSetting(stationId, key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getVarianceSettings(stationId: number): VarianceSettings {
  return {
    thresholdPct: readNumberSetting(stationId, THRESHOLD_PCT_KEY, DEFAULT_THRESHOLD_PCT),
    minLiters: readNumberSetting(stationId, MIN_LITERS_KEY, DEFAULT_MIN_LITERS),
  };
}

export function updateVarianceSettings(
  stationId: number,
  input: { thresholdPct?: number; minLiters?: number },
  actor: UserRow
): VarianceSettings {
  if (input.thresholdPct !== undefined) {
    if (!Number.isFinite(input.thresholdPct) || input.thresholdPct < 0 || input.thresholdPct > 100) {
      throw new FuelStockError("Sapma esigi 0 ile 100 arasinda bir yuzde olmalidir.", 400);
    }
    setSetting(stationId, THRESHOLD_PCT_KEY, String(input.thresholdPct), actor);
  }
  if (input.minLiters !== undefined) {
    if (!Number.isFinite(input.minLiters) || input.minLiters < 0) {
      throw new FuelStockError("En dusuk sapma litresi negatif olamaz.", 400);
    }
    setSetting(stationId, MIN_LITERS_KEY, String(input.minLiters), actor);
  }
  return getVarianceSettings(stationId);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function serializeReading(r: FuelTankReadingRow, username: string | null) {
  return {
    id: r.id,
    fuelType: r.fuel_type,
    measuredLiters: r.measured_liters,
    bookLiters: r.book_liters,
    varianceLiters: r.variance_liters,
    throughputLiters: r.throughput_liters,
    variancePct: r.variance_pct,
    previousReadingId: r.previous_reading_id,
    alarmId: r.alarm_id,
    note: r.note,
    measuredAt: r.measured_at,
    createdAt: r.created_at,
    source: r.source,
    temperatureCelsius: r.temperature_celsius,
    username,
  };
}

function getPreviousReading(stationId: number, fuelType: FuelType): FuelTankReadingRow | undefined {
  return db
    .prepare<[number, string], FuelTankReadingRow>(
      "SELECT * FROM fuel_tank_readings WHERE station_id = ? AND fuel_type = ? ORDER BY measured_at DESC, id DESC LIMIT 1"
    )
    .get(stationId, fuelType);
}

/**
 * Iki olcum arasinda tanktan gecen hacim: satislarin mutlak degeri + teslimatlar.
 * Ilk olcumde onceki bir referans olmadigindan istasyonun tum gecmisi baz alinir;
 * bu, ilk olcumun oranini kucuk gosterir ama mutlak litre farki yine de raporlanir.
 */
function calculateThroughput(stationId: number, fuelType: FuelType, since: string | null, until: string): number {
  const row = since
    ? db
        .prepare<[number, string, string, string], { total: number | null }>(
          `SELECT SUM(ABS(liters)) AS total FROM fuel_stock_movements
           WHERE station_id = ? AND fuel_type = ? AND type IN ('sale', 'delivery')
             AND created_at > ? AND created_at <= ?`
        )
        .get(stationId, fuelType, since, until)
    : db
        .prepare<[number, string, string], { total: number | null }>(
          `SELECT SUM(ABS(liters)) AS total FROM fuel_stock_movements
           WHERE station_id = ? AND fuel_type = ? AND type IN ('sale', 'delivery') AND created_at <= ?`
        )
        .get(stationId, fuelType, until);
  return round2(row?.total ?? 0);
}

export interface RecordReadingInput {
  stationId: number;
  fuelType: FuelType;
  measuredLiters: number;
  measuredAt?: string;
  note?: string | null;
  /** Seviye probundan gelen otomatik olcumlerin kullanicisi yoktur; o durumda null. */
  actor: UserRow | null;
  source?: "manual" | "auto";
  temperatureCelsius?: number | null;
}

export interface RecordReadingResult {
  reading: FuelTankReadingRow;
  alarmRaised: boolean;
}

/**
 * Bir fiziksel olcumu kaydeder, kayit stoguyla farki hesaplar, esik asilirsa
 * kritik alarm uretir ve tank seviyesini olcume esitler.
 *
 * Tanki olcume esitlemek bilincli bir tercihtir: fiziksel olcum, kayit stogundan
 * daha guvenilir bir gercektir; aksi halde fark bir sonraki olcume tasinir ve
 * ayni kayip iki kez raporlanirdi. Fark, denetim izi icin "adjustment" hareketi
 * olarak yaziya dokulur.
 */
export function recordReading(input: RecordReadingInput): RecordReadingResult {
  const { stationId, fuelType, measuredLiters, actor } = input;
  if (!Number.isFinite(measuredLiters) || measuredLiters < 0) {
    throw new FuelStockError("Olcum degeri negatif olamaz.", 400);
  }

  const tank = getTank(stationId, fuelType);
  if (measuredLiters > tank.capacity_liters) {
    throw new FuelStockError(
      `Olcum (${measuredLiters} L) tank kapasitesinden (${tank.capacity_liters} L) buyuk olamaz.`,
      400
    );
  }

  const measuredAt = input.measuredAt ?? new Date().toISOString();
  const previous = getPreviousReading(stationId, fuelType);
  if (previous && measuredAt <= previous.measured_at) {
    throw new FuelStockError("Olcum tarihi, bu yakit tipindeki son olcumden sonra olmalidir.", 400);
  }

  const bookLiters = tank.current_liters;
  const varianceLiters = round2(measuredLiters - bookLiters);
  const throughputLiters = calculateThroughput(stationId, fuelType, previous?.measured_at ?? null, measuredAt);
  // Hic hareket yoksa oran tanimsizdir; sifira bolmek yerine 0 yazilir ve karar
  // mutlak litre esigine birakilir.
  const variancePct = throughputLiters > 0 ? round2((Math.abs(varianceLiters) / throughputLiters) * 100) : 0;

  const settings = getVarianceSettings(stationId);
  const exceedsThreshold =
    Math.abs(varianceLiters) >= settings.minLiters && variancePct >= settings.thresholdPct;

  // Olcum kaydi ile tank duzeltmesi tek islemde yapilir: biri yazilip digeri
  // yazilamazsa ya raporlanan sapma tanka islenmemis olur ya da tank duzeltilip
  // sapmanin izi kaybolurdu.
  const readingId = db.transaction((): number => {
    const result = db
      .prepare(
        `INSERT INTO fuel_tank_readings
           (station_id, fuel_type, measured_liters, book_liters, variance_liters, throughput_liters,
            variance_pct, previous_reading_id, note, measured_at, user_id, source, temperature_celsius)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        stationId,
        fuelType,
        measuredLiters,
        bookLiters,
        varianceLiters,
        throughputLiters,
        variancePct,
        previous?.id ?? null,
        input.note?.trim() || null,
        measuredAt,
        actor?.id ?? null,
        input.source ?? "manual",
        input.temperatureCelsius ?? null
      );
    const id = result.lastInsertRowid as number;

    // Tank seviyesini olcume esitle. adjustStock kendi icinde hareket kaydi acar,
    // dusuk stok alarmini gozden gecirir ve panele yayin yapar.
    if (varianceLiters !== 0) {
      const direction = varianceLiters < 0 ? "kayip" : "fazla";
      adjustStock(
        stationId,
        fuelType,
        measuredLiters,
        `Fiziksel olcum #${id}: ${Math.abs(varianceLiters)} L ${direction}`,
        actor
      );
    }
    return id;
  })();

  let alarmId: number | null = null;
  if (exceedsThreshold) {
    const direction = varianceLiters < 0 ? "KAYIP" : "FAZLA";
    const alarm = createAlarm({
      stationId,
      type: "fuel_variance_exceeded",
      severity: "critical",
      message:
        `${fuelType.toUpperCase()} tankinda ${Math.abs(varianceLiters)} L ${direction} ` +
        `(hareket hacminin %${variancePct}'i). Kayit: ${round2(bookLiters)} L, olcum: ${measuredLiters} L. ` +
        `Sizinti, pompa sayac ayari veya kayit disi cekim acisindan kontrol edin.`,
    });
    alarmId = alarm.id;
    db.prepare("UPDATE fuel_tank_readings SET alarm_id = ? WHERE id = ?").run(alarmId, readingId);
  }

  const reading = db
    .prepare<[number], FuelTankReadingRow>("SELECT * FROM fuel_tank_readings WHERE id = ?")
    .get(readingId)!;
  return { reading, alarmRaised: alarmId !== null };
}

export function listReadings(
  stationId: number,
  filters: { fuelType?: FuelType; limit?: number }
): (FuelTankReadingRow & { username: string | null })[] {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const params: (number | string)[] = [stationId];
  let where = "r.station_id = ?";
  if (filters.fuelType) {
    where += " AND r.fuel_type = ?";
    params.push(filters.fuelType);
  }
  params.push(limit);
  return db
    .prepare<(number | string)[], FuelTankReadingRow & { username: string | null }>(
      `SELECT r.*, u.username AS username
       FROM fuel_tank_readings r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE ${where}
       ORDER BY r.measured_at DESC, r.id DESC
       LIMIT ?`
    )
    .all(...params);
}

export interface VarianceSummaryRow {
  fuelType: FuelType;
  readingCount: number;
  totalVarianceLiters: number;
  totalThroughputLiters: number;
  netVariancePct: number;
  lastMeasuredAt: string | null;
  lastVarianceLiters: number | null;
}

/**
 * Yakit tipi bazinda toplam sapma. Tek tek olcumlerdeki artı/eksi salinimlar
 * (olcum hassasiyeti, sicaklik) uzun vadede birbirini goturur; SUREKLI ayni
 * yonde biriken bir toplam ise gercek bir kayip demektir. Rapor bu yuzden
 * tek olcume degil, kumulatif farka bakar.
 */
export function getVarianceSummary(stationId: number): VarianceSummaryRow[] {
  return db
    .prepare<[number], VarianceSummaryRow>(
      `SELECT
         fuel_type AS fuelType,
         COUNT(*) AS readingCount,
         ROUND(SUM(variance_liters), 2) AS totalVarianceLiters,
         ROUND(SUM(throughput_liters), 2) AS totalThroughputLiters,
         CASE WHEN SUM(throughput_liters) > 0
              THEN ROUND(SUM(variance_liters) * 100.0 / SUM(throughput_liters), 3)
              ELSE 0 END AS netVariancePct,
         MAX(measured_at) AS lastMeasuredAt,
         NULL AS lastVarianceLiters
       FROM fuel_tank_readings
       WHERE station_id = ?
       GROUP BY fuel_type
       ORDER BY fuel_type ASC`
    )
    .all(stationId)
    .map((row) => {
      const last = db
        .prepare<[number, string], { variance_liters: number }>(
          "SELECT variance_liters FROM fuel_tank_readings WHERE station_id = ? AND fuel_type = ? ORDER BY measured_at DESC, id DESC LIMIT 1"
        )
        .get(stationId, row.fuelType);
      return { ...row, lastVarianceLiters: last?.variance_liters ?? null };
    });
}
