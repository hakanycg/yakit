import { db } from "../db/index.js";
import type { FuelType, UserRow } from "../db/types.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { createAlarm } from "./alarmService.js";
import { BUSINESS_DAY_SQL_OFFSET } from "../utils/businessDay.js";

/**
 * Teslimat kabul farki - eksik gelen tankerin tespiti.
 *
 * Bugune kadar teslimat TEK bir litre rakamiyla kaydediliyordu ve o rakama kosulsuz
 * guveniliyordu. Gercekte her teslimatin IKI rakami vardir:
 *
 *   1. Irsaliyede yazan (ve faturalandigimiz) miktar
 *   2. Tanka FIILEN giren miktar (teslimat oncesi/sonrasi seviye farki)
 *
 * Ikisinin arasindaki fark, sizintidan sonra istasyonun en yaygin kayip kaynagidir:
 * 20.000 L yazip 19.600 L bosaltan bir tanker, gunun fiyatiyla ~22.000 TL'lik bir kayip
 * demektir ve bugun hicbir yerde gorunmez.
 *
 * DAHA KOTUSU: irsaliye rakami kayit stoguna yazildiginda yakit sapma takibini de
 * (bkz. fuelVarianceService.ts) zehirler. Sismis kayit stogu, eksik gelen yakiti
 * teslimat aninda degil, SONRAKI GUNLERE yayilmis gizemli bir kayip olarak gosterir -
 * yani operator sizinti arar, oysa sorun tankerdedir. Bu yuzden olcum varsa kayit
 * stoguna FIILEN GIREN miktar yazilir; fark ayri bir kalem olarak kayda gecer.
 */

/**
 * Yuzde esigi. Akaryakit teslimatinda sicaklik farki (tankerde baska sicaklikta olculen
 * hacim, tankta baska) ve olcum toleransi yuzunden kucuk farklar normaldir.
 */
const DEFAULT_THRESHOLD_PCT = 0.5;

/**
 * Mutlak taban. Kucuk bir teslimatta (ör. 500 L LPG) %0.5 sadece 2.5 L eder ve olcum
 * hassasiyeti bunun altindadir - yuzde tek basina yanlis alarm uretirdi. Ikisi de
 * asilmadikca alarm CIKMAZ (ayni desen: fuelVarianceService.ts).
 */
const DEFAULT_MIN_LITERS = 100;

const THRESHOLD_PCT_KEY = "delivery_variance_threshold_pct";
const MIN_LITERS_KEY = "delivery_variance_min_liters";

/**
 * Kendi hata tipi - fuelStockService'ten FuelStockError almiyoruz cunku o modul de bu
 * modulu import ediyor ve dairesel bir bagimlilik olusurdu. Calisma zamaninda bugun
 * sorun cikarmazdi (referanslar fonksiyon govdelerinde) ama import sirasi degistiginde
 * sessizce undefined'a donusen turden bir kirilganliktir.
 */
export class DeliveryVarianceError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface DeliveryVarianceSettings {
  thresholdPct: number;
  minLiters: number;
}

function readNumberSetting(stationId: number, key: string, fallback: number): number {
  const raw = getSetting(stationId, key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getDeliveryVarianceSettings(stationId: number): DeliveryVarianceSettings {
  return {
    thresholdPct: readNumberSetting(stationId, THRESHOLD_PCT_KEY, DEFAULT_THRESHOLD_PCT),
    minLiters: readNumberSetting(stationId, MIN_LITERS_KEY, DEFAULT_MIN_LITERS),
  };
}

export function updateDeliveryVarianceSettings(
  stationId: number,
  input: { thresholdPct?: number; minLiters?: number },
  actor: UserRow
): DeliveryVarianceSettings {
  if (input.thresholdPct !== undefined) {
    if (!Number.isFinite(input.thresholdPct) || input.thresholdPct < 0 || input.thresholdPct > 100) {
      throw new DeliveryVarianceError("Teslimat farki esigi 0 ile 100 arasinda bir yuzde olmalidir.", 400);
    }
    setSetting(stationId, THRESHOLD_PCT_KEY, String(input.thresholdPct), actor);
  }
  if (input.minLiters !== undefined) {
    if (!Number.isFinite(input.minLiters) || input.minLiters < 0) {
      throw new DeliveryVarianceError("En dusuk teslimat farki litresi negatif olamaz.", 400);
    }
    setSetting(stationId, MIN_LITERS_KEY, String(input.minLiters), actor);
  }
  return getDeliveryVarianceSettings(stationId);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface DeliveryMeasurement {
  /** Irsaliyede yazan miktar. */
  declaredLiters: number;
  /** Teslimattan onceki tank seviyesi. Olculmediyse undefined. */
  measuredBefore?: number;
  /** Teslimattan sonraki tank seviyesi. Olculmediyse undefined. */
  measuredAfter?: number;
}

export interface DeliveryVarianceResult {
  /** Kayit stoguna eklenecek miktar: olcum varsa FIILEN giren, yoksa irsaliye miktari. */
  acceptedLiters: number;
  varianceLiters: number | null;
  variancePct: number | null;
  /** Esik asildi mi? Alarm bu bayraga gore uretilir. */
  exceedsThreshold: boolean;
  /** Olcum girilmedigi icin fark hesaplanamadi. */
  unmeasured: boolean;
}

/**
 * Teslimatin kabul edilecek miktarini ve farkini hesaplar.
 *
 * Olcum girilmemisse fark hesaplanamaz ve irsaliye miktari kabul edilir - eski davranis.
 * Bunu "fark yok" olarak KAYDETMEK yaniltici olurdu: "olctuk, tuttu" ile "hic olcmedik"
 * ayni sey degildir (ayni ayrim: portfolioService'te varianceLiters null).
 */
export function evaluateDelivery(stationId: number, m: DeliveryMeasurement): DeliveryVarianceResult {
  const measured =
    m.measuredBefore !== undefined && m.measuredAfter !== undefined
      ? round2(m.measuredAfter - m.measuredBefore)
      : null;

  if (measured === null) {
    return {
      acceptedLiters: m.declaredLiters,
      varianceLiters: null,
      variancePct: null,
      exceedsThreshold: false,
      unmeasured: true,
    };
  }

  const varianceLiters = round2(measured - m.declaredLiters);
  // Yuzde IRSALIYE miktarina gore: "siparis ettigimizin yuzde kaci eksik geldi" sorusunun
  // cevabi budur. Fiilen girene bolmek, eksik geldikce paydayi kucultup farki oldugundan
  // buyuk gosterirdi.
  const variancePct = m.declaredLiters > 0 ? round2((Math.abs(varianceLiters) / m.declaredLiters) * 100) : 0;

  const settings = getDeliveryVarianceSettings(stationId);
  // Fazla gelen yakit da bir uyusmazliktir (yanlis tank, yanlis irsaliye) ama alarm
  // yalnizca EKSIK teslimatta uretilir: fazlasi istasyonun aleyhine degildir ve kritik
  // alarm kuyrugunu doldurmasi operatorun gercek alarmlari kacirmasina yol acardi.
  // Fark her durumda kayda gecer ve tedarikci karnesinde gorunur.
  const exceedsThreshold =
    varianceLiters < 0 && Math.abs(varianceLiters) >= settings.minLiters && variancePct >= settings.thresholdPct;

  return { acceptedLiters: measured, varianceLiters, variancePct, exceedsThreshold, unmeasured: false };
}

/**
 * Eksik teslimat alarmi. Tedarikci ve irsaliye numarasi mesajda yer alir: itiraz ancak
 * tanker sofuru daha sahadayken yapilabilir, dolayisiyla alarmin kimi arayacagini ve
 * hangi belgeye itiraz edilecegini soylemesi gerekir.
 */
export function raiseShortDeliveryAlarm(params: {
  stationId: number;
  fuelType: FuelType;
  supplier: string | null;
  deliveryRef: string | null;
  declaredLiters: number;
  acceptedLiters: number;
  varianceLiters: number;
  variancePct: number;
}): void {
  const parts = [
    `${params.fuelType} teslimati EKSIK geldi:`,
    `irsaliye ${params.declaredLiters} L, tanka giren ${params.acceptedLiters} L`,
    `(${params.varianceLiters} L, %${params.variancePct}).`,
  ];
  if (params.supplier) parts.push(`Tedarikci: ${params.supplier}.`);
  if (params.deliveryRef) parts.push(`Irsaliye no: ${params.deliveryRef}.`);
  parts.push("Tanker sahadan ayrilmadan tutanak tutun.");

  createAlarm({
    stationId: params.stationId,
    type: "short_delivery",
    severity: "critical",
    message: parts.join(" "),
  });
}

export interface SupplierDeliveryVarianceRow {
  supplier: string;
  deliveryCount: number;
  /** Olcumu olan teslimat sayisi; kumulatif fark yalnizca bunlari kapsar. */
  measuredCount: number;
  declaredLiters: number;
  acceptedLiters: number;
  varianceLiters: number;
  variancePct: number;
  lastDeliveryAt: string | null;
}

/**
 * Tedarikci karnesi.
 *
 * Tek bir teslimattaki %0.4'luk fark toleransin icinde kalir ve alarm uretmez; ama ayni
 * tedarikci HER SEFERINDE %0.4 eksik getiriyorsa bu bir tolerans degil bir DESENDIR ve
 * yalnizca toplamda gorunur. Alarm tek teslimata, bu rapor iliskiye bakar.
 */
export function getSupplierDeliveryVariance(stationId: number, from?: string, to?: string): SupplierDeliveryVarianceRow[] {
  const clauses = ["m.station_id = ?", "m.type = 'delivery'", "m.supplier IS NOT NULL"];
  const params: (string | number)[] = [stationId];
  if (from) {
    clauses.push(`date(m.created_at, '${BUSINESS_DAY_SQL_OFFSET}') >= ?`);
    params.push(from);
  }
  if (to) {
    clauses.push(`date(m.created_at, '${BUSINESS_DAY_SQL_OFFSET}') <= ?`);
    params.push(to);
  }

  return db
    .prepare<(string | number)[], SupplierDeliveryVarianceRow>(
      `SELECT m.supplier AS supplier,
              COUNT(*) AS deliveryCount,
              SUM(CASE WHEN m.delivery_variance_liters IS NOT NULL THEN 1 ELSE 0 END) AS measuredCount,
              COALESCE(ROUND(SUM(CASE WHEN m.delivery_variance_liters IS NOT NULL THEN COALESCE(m.declared_liters, m.liters) ELSE 0 END), 2), 0) AS declaredLiters,
              -- Fiilen bosaltilan miktar m.liters DEGILDIR: m.liters tank kapasitesiyle
              -- SINIRLANMIS, yani tanka sigan miktardir. Tasma olan bir teslimatta ikisi
              -- ayrisir ve m.liters kullanilirsa satir kendi kendisiyle celisir
              -- (irsaliye 20.000, "fiilen giren" 7.000, fark -400). Fiilen bosaltilan,
              -- tanimi geregi irsaliye + fark'tir.
              COALESCE(ROUND(SUM(CASE WHEN m.delivery_variance_liters IS NOT NULL
                                      THEN COALESCE(m.declared_liters, 0) + m.delivery_variance_liters
                                      ELSE 0 END), 2), 0) AS acceptedLiters,
              COALESCE(ROUND(SUM(m.delivery_variance_liters), 2), 0) AS varianceLiters,
              0 AS variancePct,
              MAX(m.created_at) AS lastDeliveryAt
       FROM fuel_stock_movements m
       WHERE ${clauses.join(" AND ")}
       GROUP BY m.supplier
       ORDER BY varianceLiters ASC, m.supplier`
    )
    .all(...params)
    .map((r) => ({
      ...r,
      // Yuzde satirda hesaplanir: olcumu olmayan tedarikcide payda 0 olur ve sifira bolme
      // korumasini SQL icine yazmak okunurlugu bozardi.
      variancePct: r.declaredLiters > 0 ? round2((r.varianceLiters / r.declaredLiters) * 100) : 0,
    }));
}
