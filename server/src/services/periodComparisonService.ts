import { db } from "../db/index.js";
import { getTotalFuelCost } from "./fuelStockService.js";

/**
 * Donemsel karsilastirma raporu (bkz. arastirma bulgusu: "bu ay/gecen ay, bu yil/gecen
 * yil ayni donem karsilastirmasi hicbir yerde yok"). Iki tarih araligini (ör. bu ay ve
 * gecen ay) yan yana koyar - ciro, litre, islem sayisi, brut kar - ve aralarindaki
 * yuzde degisimi hesaplar. profitLossService.ts'teki AYNI temel sorgu (chargeAmount =
 * MAX(0, total_amount - discount_amount)) tekrar kullanilir, ikinci bir aralik icin
 * ikinci kez calistirilir.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface PeriodMetrics {
  from: string;
  to: string;
  revenue: number;
  liters: number;
  transactionCount: number;
  grossProfit: number;
  grossMarginPct: number | null;
}

export interface PeriodComparison {
  current: PeriodMetrics;
  previous: PeriodMetrics;
  /** current'in previous'a gore yuzde degisimi. previous=0 ise (ve current>0 ise) tanimsizdir (null). */
  changePct: {
    revenue: number | null;
    liters: number | null;
    transactionCount: number | null;
    grossProfit: number | null;
  };
}

function getPeriodMetrics(stationId: number, from: string, to: string): PeriodMetrics {
  const row = db
    .prepare<[number, string, string], { revenue: number; liters: number; transactionCount: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN MAX(0, total_amount - discount_amount) ELSE 0 END), 0) as revenue,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN dispensed_liters ELSE 0 END), 0) as liters,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as transactionCount
       FROM transactions WHERE station_id = ? AND created_at >= ? AND created_at <= ?`
    )
    .get(stationId, from, `${to}T23:59:59.999Z`)!;

  const revenue = round2(row.revenue);
  const cogs = getTotalFuelCost(stationId, from, to);
  const grossProfit = round2(revenue - cogs);

  return {
    from,
    to,
    revenue,
    liters: round2(row.liters),
    transactionCount: row.transactionCount,
    grossProfit,
    grossMarginPct: revenue > 0 ? round2((grossProfit / revenue) * 100) : null,
  };
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return round2(((current - previous) / previous) * 100);
}

export function getPeriodComparison(
  stationId: number,
  currentFrom: string,
  currentTo: string,
  previousFrom: string,
  previousTo: string
): PeriodComparison {
  const current = getPeriodMetrics(stationId, currentFrom, currentTo);
  const previous = getPeriodMetrics(stationId, previousFrom, previousTo);

  return {
    current,
    previous,
    changePct: {
      revenue: pctChange(current.revenue, previous.revenue),
      liters: pctChange(current.liters, previous.liters),
      transactionCount: pctChange(current.transactionCount, previous.transactionCount),
      grossProfit: pctChange(current.grossProfit, previous.grossProfit),
    },
  };
}
