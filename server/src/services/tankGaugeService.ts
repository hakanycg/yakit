import { db } from "../db/index.js";
import type { FuelType, StationRow } from "../db/types.js";
import { logger } from "../utils/logger.js";
import { FUEL_TYPES } from "./fuelStockService.js";
import { recordReading } from "./fuelVarianceService.js";
import { getTankGaugeDriver } from "./tankGaugeDriver.js";

/**
 * Seviye probundan periyodik otomatik olcum.
 *
 * Yakit sapma takibi elle olcume bagli kaldiginda pratikte ya seyrek yapilir ya hic,
 * ve sizinti tespiti sessizce calismaz hale gelir. Bu dongu, prob bagliysa olcumu
 * insandan bagimsiz hale getirir.
 */

/**
 * Okumalar arasi en kisa sure.
 *
 * ONEMLI: bunu birkac dakikaya indirmek sapma takibini BOZAR. Sapma orani, iki olcum
 * arasinda tanktan gecen hacme bolunur (bkz. fuelVarianceService.ts); 5 dakikada bir
 * olculurse aradaki hacim neredeyse sifir olur ve probun birkac litrelik normal
 * salinimi yuzde olarak devasa gorunur - tam da iki esikli korumayla onlemeye
 * calistigimiz yanlis alarm bicimi. Saatlik aralik anlamli bir hacim birakir.
 */
const MIN_INTERVAL_MS = 60 * 60 * 1000;

interface ActiveDispenseRow {
  c: number;
}

/**
 * Dolum suruyorken olcum alinmaz.
 *
 * Yakit akarken tanktaki seviye hem duser hem calkalanir; probun o andaki okumasi
 * kararsizdir ve gercek bir kayipmis gibi gorunen bir fark uretir. Gercek ATG
 * sistemleri de bu yuzden "sakin donem" bekler.
 */
function hasActiveDispense(stationId: number): boolean {
  const row = db
    .prepare<[number], ActiveDispenseRow>(
      "SELECT COUNT(*) AS c FROM transactions WHERE station_id = ? AND status IN ('dispensing', 'authorized', 'paid')"
    )
    .get(stationId)!;
  return row.c > 0;
}

function lastAutoReadingAt(stationId: number, fuelType: FuelType): number | null {
  const row = db
    .prepare<[number, string], { measured_at: string }>(
      "SELECT measured_at FROM fuel_tank_readings WHERE station_id = ? AND fuel_type = ? ORDER BY measured_at DESC, id DESC LIMIT 1"
    )
    .get(stationId, fuelType);
  return row ? new Date(row.measured_at).getTime() : null;
}

export interface GaugeSweepResult {
  recorded: number;
  skippedNoProbe: number;
  skippedDispensing: number;
  skippedTooSoon: number;
  alarmsRaised: number;
}

/**
 * Tum aktif istasyonlarin tanklarini tarar ve prob deger donduren her tank icin bir
 * olcum kaydeder. Kayit, elle girilen olcumle AYNI yoldan (recordReading) gecer:
 * boylece esik kontrolu, alarm uretimi ve tank duzeltmesi tek yerde kalir.
 */
export function sweepTankGauges(now = Date.now()): GaugeSweepResult {
  const result: GaugeSweepResult = {
    recorded: 0,
    skippedNoProbe: 0,
    skippedDispensing: 0,
    skippedTooSoon: 0,
    alarmsRaised: 0,
  };
  const driver = getTankGaugeDriver();
  const stations = db.prepare<[], StationRow>("SELECT * FROM stations WHERE active = 1").all();

  for (const station of stations) {
    if (hasActiveDispense(station.id)) {
      result.skippedDispensing += FUEL_TYPES.length;
      continue;
    }

    for (const fuelType of FUEL_TYPES) {
      const last = lastAutoReadingAt(station.id, fuelType);
      if (last !== null && now - last < MIN_INTERVAL_MS) {
        result.skippedTooSoon++;
        continue;
      }

      let reading;
      try {
        reading = driver.read(station.id, fuelType);
      } catch (err) {
        // Bir tankin probu arizaliysa digerlerinin okunmasi engellenmemeli.
        logger.error({ err, stationId: station.id, fuelType }, "Tank seviye probu okunamadi.");
        result.skippedNoProbe++;
        continue;
      }

      // null "sifir litre" DEGILDIR: prob bagli degil ya da o an okunamiyor demektir.
      // Okunamayan bir probu bos tank saymak dogrudan yanlis bir kayip alarmi uretirdi.
      if (reading === null) {
        result.skippedNoProbe++;
        continue;
      }
      if (!Number.isFinite(reading.liters) || reading.liters < 0) {
        logger.error({ stationId: station.id, fuelType, liters: reading.liters }, "Tank probu gecersiz deger dondurdu.");
        result.skippedNoProbe++;
        continue;
      }

      try {
        const { alarmRaised } = recordReading({
          stationId: station.id,
          fuelType,
          measuredLiters: reading.liters,
          // Prob kendi okuma zamanini bildirmediyse taramanin zamani kullanilir.
          // Tarama kendi esik kontrollerini `now` uzerinden yapiyor; olcume baska bir
          // zaman yazmak, "ne zaman olctum" ile "ne zamana gore karar verdim"i
          // birbirinden ayirir ve hareket hacmi penceresini kaydirirdi.
          measuredAt: reading.measuredAt ?? new Date(now).toISOString(),
          actor: null,
          source: "auto",
          temperatureCelsius: reading.temperatureCelsius ?? null,
          waterLevelMm: reading.waterLevelMm ?? null,
          note: "Seviye probu otomatik olcumu",
        });
        result.recorded++;
        if (alarmRaised) result.alarmsRaised++;
      } catch (err) {
        logger.error({ err, stationId: station.id, fuelType }, "Otomatik tank olcumu kaydedilemedi.");
      }
    }
  }

  return result;
}
