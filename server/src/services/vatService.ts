import { VAT_RATE } from "./invoiceService.js";
import { getProfitLossSummary } from "./profitLossService.js";

/**
 * KDV Ozet Raporu (on muhasebe, 5. modul).
 *
 * Yeni SQL sorgusu yok - modul #4'un (profitLossService) zaten dondurdugu
 * revenue/cogs/expenses uzerine ince bir KDV katmani. Hesaplanan KDV (satis)
 * pompa fiyatinin KDV DAHIL olmasindan geriye hesaplanir (invoiceService.ts/
 * accountingExportService.ts ile ayni yontem, ayni VAT_RATE sabiti). Filo
 * donemsel faturalarinin kendi gercek tax_amount'i KASITLI olarak kullanilmaz:
 * onlar zaten ayni transactions satirlarinin yeniden faturalandirilmis hali,
 * ekstra eklemek KDV'yi cift sayardi.
 *
 * Indirilecek KDV (alim/gider) TAHMINIDIR: fuel_stock_movements.unit_cost ve
 * expenses.amount'ta KDV dahil/haric bilgisi hic tutulmuyor, bu yuzden ayni
 * %20 KDV dahil varsayimiyla geriye hesaplaniyor (reports.ts'teki
 * estimatedGrossProfit'in "TAHMINI" acikliğiyla ayni durustluk ilkesi).
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function vatFromInclusive(amountIncl: number): number {
  return round2(amountIncl - amountIncl / (1 + VAT_RATE));
}

export interface VatSummary {
  from: string | null;
  to: string | null;
  outputVatBase: number;
  outputVat: number;
  inputVatBase: number;
  inputVat: number;
  netVat: number;
}

export function getVatSummary(stationId: number, from?: string, to?: string): VatSummary {
  const pl = getProfitLossSummary(stationId, from, to);
  const inputVatBase = round2(pl.cogs + pl.expenses);
  const outputVat = vatFromInclusive(pl.revenue);
  const inputVat = vatFromInclusive(inputVatBase);

  return {
    from: from ?? null,
    to: to ?? null,
    outputVatBase: pl.revenue,
    outputVat,
    inputVatBase,
    inputVat,
    netVat: round2(outputVat - inputVat),
  };
}
