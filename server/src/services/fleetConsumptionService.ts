import { db } from "../db/index.js";
import type { FuelType } from "../db/types.js";

/**
 * Filo aracinin yakit tuketimi (L/100km).
 *
 * Filo sahibi bugune kadar "hangi arac ne kadar ALDI" goruyordu; "ne kadar YAKTI"
 * goremiyordu. Ikisi ayni sey degildir ve fark tam olarak surucu kaynakli yakit
 * kacaginin sakli oldugu yerdir: filo ortalamasinin belirgin ustunde yakan bir aracta
 * ya gercek bir ariza vardir ya da yakit baska bir yere gidiyordur.
 *
 * Hesap iki ARDISIK dolum arasindan cikar: aradaki km ve o araliktaki litre.
 *
 *   L/100km = (ikinci dolumun litresi / (ikinci km - birinci km)) x 100
 *
 * Litre olarak IKINCI dolum alinir, cunku o litre birinci dolumdan bu yana yakilan
 * yakitin yerine konmus olanidir (depoyu her seferinde ayni doluluga getirdigi
 * varsayimi - filo araclarinda olagan pratik).
 */

/**
 * Turetilen degerin makul araligi. Dogrulama HAM km'ye degil SONUCA yapiliyor:
 * bir hane eksik/fazla yazilmasi (123456 yerine 12345) km'de makul gorunebilir ama
 * tuketimi imkansiz bir sayiya cevirir. Yol araclari bu araligin disina cikmaz;
 * cikan bir cift olcum hatasidir ve ortalamayi bozmamalidir.
 */
const MIN_PLAUSIBLE_L_PER_100KM = 1;
const MAX_PLAUSIBLE_L_PER_100KM = 200;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface FillRow {
  id: number;
  plate: string;
  fuel_type: FuelType;
  liters: number;
  odometer_km: number;
  completed_at: string;
}

export interface ConsumptionPoint {
  transactionId: number;
  fuelType: FuelType;
  liters: number;
  odometerKm: number;
  distanceKm: number;
  litersPer100Km: number;
  completedAt: string;
}

export interface PlateConsumption {
  plate: string;
  /** Gecerli olcum cifti sayisi (dolum sayisi degil). */
  sampleCount: number;
  /** Olculebilen toplam mesafe. */
  totalDistanceKm: number;
  totalLiters: number;
  /** Toplam litre / toplam km - tek tek olcumlerin ortalamasi DEGIL (bkz. asagidaki not). */
  litersPer100Km: number | null;
  lastOdometerKm: number | null;
  lastFillAt: string | null;
  /** Km girilmemis ya da makul olmayan cift sayisi - guven duzeyini gosterir. */
  skippedPairs: number;
  points: ConsumptionPoint[];
}

export interface FleetConsumptionReport {
  plates: PlateConsumption[];
  /** Filo geneli L/100km; kiyaslama esigi budur. */
  fleetAverage: number | null;
  /** Filo ortalamasindan bu orandan fazla sapan araclar isaretlenir. */
  outlierThresholdPct: number;
}

const OUTLIER_THRESHOLD_PCT = 25;

/**
 * Hesaba ait dolumlar.
 *
 * ISTASYON KOSULU SART: plaka metni istasyonlar arasinda benzersiz degildir ve
 * yalnizca plakaya bakan bir eslesme, ayni plakanin BASKA bir istasyonda yaptigi
 * dolumlari da bu sirketin raporuna sokardi - kiracilar arasi veri sizintisi.
 * Filo hesabi zaten istasyon kapsamlidir (fleet_accounts.station_id), rapor da oyle.
 *
 * Siralama ZAMANA gore: km'ye gore siralamak, yanlis girilmis bir okumayi dogru
 * yerine oturtmus gibi yapip hatayi gizlerdi. Dolumlar gercekte hangi sirayla
 * olduysa o sirayla degerlendirilir; tutarsiz km zaten elenir.
 */
function fillsForAccount(accountId: number, from: string, to: string): FillRow[] {
  return db
    .prepare<[number, string, string], FillRow>(
      `SELECT t.id, t.plate, t.fuel_type, t.dispensed_liters AS liters, t.odometer_km, t.completed_at
         FROM transactions t
         JOIN fleet_plates p ON p.plate = t.plate
         JOIN fleet_accounts a ON a.id = p.fleet_account_id
        WHERE p.fleet_account_id = ?
          AND t.station_id = a.station_id
          AND t.status = 'completed'
          AND t.odometer_km IS NOT NULL
          AND t.dispensed_liters > 0
          AND t.completed_at >= ? AND t.completed_at <= ?
        ORDER BY t.plate, t.completed_at, t.id`
    )
    .all(accountId, from, `${to}T23:59:59.999Z`);
}

/**
 * Bir aracin ardisik dolumlarindan tuketim noktalari uretir.
 *
 * Atlanan ciftler SAYILIR ama sessizce yok sayilmaz: kac olcumun kullanilamadigini
 * bilmek, ortalamaya ne kadar guvenilecegini belirler. Km'si geriye giden bir okuma
 * (yanlis giris ya da sayac degisimi) ve imkansiz bir tuketim ureten cift elenir.
 */
function pointsFor(fills: FillRow[]): { points: ConsumptionPoint[]; skipped: number } {
  const points: ConsumptionPoint[] = [];
  let skipped = 0;

  for (let i = 1; i < fills.length; i += 1) {
    const previous = fills[i - 1]!;
    const current = fills[i]!;
    const distanceKm = current.odometer_km - previous.odometer_km;

    if (distanceKm <= 0) {
      skipped += 1;
      continue;
    }

    const litersPer100Km = round2((current.liters / distanceKm) * 100);
    if (litersPer100Km < MIN_PLAUSIBLE_L_PER_100KM || litersPer100Km > MAX_PLAUSIBLE_L_PER_100KM) {
      skipped += 1;
      continue;
    }

    points.push({
      transactionId: current.id,
      fuelType: current.fuel_type,
      liters: round2(current.liters),
      odometerKm: current.odometer_km,
      distanceKm,
      litersPer100Km,
      completedAt: current.completed_at,
    });
  }

  return { points, skipped };
}

export function getConsumptionReport(accountId: number, from: string, to: string): FleetConsumptionReport {
  const byPlate = new Map<string, FillRow[]>();
  for (const fill of fillsForAccount(accountId, from, to)) {
    const list = byPlate.get(fill.plate) ?? [];
    list.push(fill);
    byPlate.set(fill.plate, list);
  }

  const plates: PlateConsumption[] = [];
  let fleetLiters = 0;
  let fleetDistance = 0;

  for (const [plate, fills] of byPlate) {
    const { points, skipped } = pointsFor(fills);
    const totalDistanceKm = points.reduce((n, p) => n + p.distanceKm, 0);
    const totalLiters = round2(points.reduce((n, p) => n + p.liters, 0));
    fleetLiters += totalLiters;
    fleetDistance += totalDistanceKm;

    plates.push({
      plate,
      sampleCount: points.length,
      totalDistanceKm,
      totalLiters,
      // TOPLAM litre / TOPLAM km kullaniliyor, tek tek olcumlerin ortalamasi degil:
      // 20 km'lik bir aralikta olculen tuketim, 800 km'lik bir aralikta olculenle
      // ayni agirligi tasimamali - kisa araliklarda depo doluluk farki orani savurur.
      litersPer100Km: totalDistanceKm > 0 ? round2((totalLiters / totalDistanceKm) * 100) : null,
      lastOdometerKm: fills.at(-1)?.odometer_km ?? null,
      lastFillAt: fills.at(-1)?.completed_at ?? null,
      skippedPairs: skipped,
      points,
    });
  }

  plates.sort((a, b) => (b.litersPer100Km ?? -1) - (a.litersPer100Km ?? -1));

  return {
    plates,
    fleetAverage: fleetDistance > 0 ? round2((fleetLiters / fleetDistance) * 100) : null,
    outlierThresholdPct: OUTLIER_THRESHOLD_PCT,
  };
}
