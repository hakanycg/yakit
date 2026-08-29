import { db } from "../db/index.js";
import { getTotalFuelCost } from "./fuelStockService.js";
import { summarizeExpenses } from "./expenseService.js";

/**
 * Gelir-Gider Ozeti (on muhasebe, 4. modul).
 *
 * Uc mevcut veri kaynagini birlestirir: gelir (transactions, reports.ts'in
 * /summary ucundeki chargeAmount hesabiyla AYNI), yakit maliyeti (COGS,
 * getTotalFuelCost - gercek maliyet, reports.ts'teki GUNCEL ortalama maliyetle
 * TAHMINI estimatedGrossProfit'ten farkli olarak), ve genel giderler
 * (summarizeExpenses, modul #1). Tedarikci borc bakiyesi (modul #2,
 * getSupplierLedger) kasitli olarak KULLANILMAZ - o kumulatif bir bilanço
 * kavrami, bu tarih araligindaki donemsel maliyet degil.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ProfitLossSummary {
  from: string | null;
  to: string | null;
  revenue: number;
  discount: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number | null;
  expenses: number;
  netProfit: number;
  netMarginPct: number | null;
}

export function getProfitLossSummary(stationId: number, from?: string, to?: string): ProfitLossSummary {
  const clauses = ["station_id = ?"];
  const params: (string | number)[] = [stationId];
  if (from) {
    clauses.push("created_at >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("created_at <= ?");
    params.push(`${to}T23:59:59.999Z`);
  }

  const revenueRow = db
    .prepare<(string | number)[], { revenue: number; discount: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN MAX(0, total_amount - discount_amount) ELSE 0 END), 0) as revenue,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN discount_amount ELSE 0 END), 0) as discount
       FROM transactions WHERE ${clauses.join(" AND ")}`
    )
    .get(...params)!;

  const revenue = round2(revenueRow.revenue);
  const discount = round2(revenueRow.discount);
  const cogs = getTotalFuelCost(stationId, from, to);
  const expenses = summarizeExpenses(stationId, from, to).total;

  const grossProfit = round2(revenue - cogs);
  const netProfit = round2(grossProfit - expenses);

  return {
    from: from ?? null,
    to: to ?? null,
    revenue,
    discount,
    cogs,
    grossProfit,
    grossMarginPct: revenue > 0 ? round2((grossProfit / revenue) * 100) : null,
    expenses,
    netProfit,
    netMarginPct: revenue > 0 ? round2((netProfit / revenue) * 100) : null,
  };
}
