import { db } from "../db/index.js";
import { businessDayExpr } from "../utils/businessDay.js";
import { VAT_RATE } from "./invoiceService.js";

/**
 * Muhasebe/BI disa aktarimi.
 *
 * Logo/Netsis/Mikro gibi urunlerin resmi API dokumantasyonu elimizde yok - bu yuzden
 * onlara "gercek" bir entegrasyon YAZILMIYOR (iyzico/Uyumsoft'un aksine, orada resmi
 * API dokumanlari vardi ve o yuzden gercek istemci yazildi). Bunun yerine, bu urunlerin
 * neredeyse tamami tarafindan kabul edilen CSV/Excel ice aktarma sekline uyan jenerik,
 * is gunu bazinda bir ozet - ve ayni veriye programatik erisim icin bir JSON uc.
 *
 * Is gunu tanimi (utils/businessDay.ts) reconciliationService.ts/portfolioService.ts
 * ile AYNIDIR - bu rapor, gun sonu mutabakati ile FARKLI bir "bugun" gostermemeli.
 *
 * discount_amount tek bir para birimi kolonudur; kampanya kodu indirimi ile sadakat
 * puani kullanimi ayni kolonda BIRLESIKTIR (bkz. transactionService.ts) - ikisini ayri
 * para tutarlarina bolecek bir veri yok. Bu yuzden burada da uydurulmuyor: discountAmount
 * (para, birlesik) ile loyaltyPointsRedeemed (PUAN, bilgi amacli, para degil) ayri
 * alanlar olarak raporlanir.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface AccountingExportRow {
  businessDate: string;
  transactionCount: number;
  grossRevenue: number;
  discountAmount: number;
  loyaltyPointsRedeemed: number;
  /** Musteriden GERCEKTEN tahsil edilen tutar (KDV dahil) - MAX(0, brut - indirim). */
  netRevenue: number;
  /** netRevenue icindeki KDV tutari (VAT_RATE ile netRevenue'dan geriye hesaplanir). */
  vatAmount: number;
  /** netRevenue - vatAmount. */
  netRevenueExVat: number;
  refundCount: number;
  refundAmount: number;
  /** Odeme yontemine gore o gunun net tahsilati (iyzico/fleet/pos/virtual_card ...). */
  byPaymentMethod: Record<string, number>;
}

export interface AccountingExportTotals {
  transactionCount: number;
  grossRevenue: number;
  discountAmount: number;
  loyaltyPointsRedeemed: number;
  netRevenue: number;
  vatAmount: number;
  netRevenueExVat: number;
  refundCount: number;
  refundAmount: number;
}

export interface AccountingExport {
  from: string;
  to: string;
  /** CSV basliklarinin sabit sirada kalmasi icin - araliktaki tum gunlerde gorulen yontemlerin birlesimi. */
  paymentMethods: string[];
  rows: AccountingExportRow[];
  totals: AccountingExportTotals;
}

function vatSplit(netRevenue: number): { vatAmount: number; netRevenueExVat: number } {
  const netRevenueExVat = round2(netRevenue / (1 + VAT_RATE));
  return { netRevenueExVat, vatAmount: round2(netRevenue - netRevenueExVat) };
}

export function buildAccountingExport(stationId: number, from: string, to: string): AccountingExport {
  const dayExpr = businessDayExpr();

  const dayTotals = db
    .prepare<
      [number, string, string],
      { businessDate: string; transactionCount: number; grossRevenue: number; discountAmount: number; loyaltyPointsRedeemed: number; netRevenue: number }
    >(
      `SELECT ${dayExpr} AS businessDate,
              COUNT(*) AS transactionCount,
              COALESCE(SUM(total_amount), 0) AS grossRevenue,
              COALESCE(SUM(discount_amount), 0) AS discountAmount,
              COALESCE(SUM(loyalty_points_redeemed), 0) AS loyaltyPointsRedeemed,
              COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0) AS netRevenue
       FROM transactions
       WHERE station_id = ? AND status = 'completed' AND ${dayExpr} BETWEEN ? AND ?
       GROUP BY businessDate`
    )
    .all(stationId, from, to);

  const byMethodRows = db
    .prepare<[number, string, string], { businessDate: string; paymentMethod: string; netRevenue: number }>(
      `SELECT ${dayExpr} AS businessDate,
              payment_method AS paymentMethod,
              COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0) AS netRevenue
       FROM transactions
       WHERE station_id = ? AND status = 'completed' AND ${dayExpr} BETWEEN ? AND ?
       GROUP BY businessDate, payment_method`
    )
    .all(stationId, from, to);

  // Iadeler KESILDIKLERI gune yazilir (orijinal satisin gunune degil) - gun sonu
  // mutabakatiyla (reconciliationService.ts) AYNI kural, iki rapor birbirini tutsun diye.
  const refundRows = db
    .prepare<[number, string, string], { businessDate: string; refundCount: number; refundAmount: number }>(
      `SELECT date(created_at, '+3 hours') AS businessDate,
              COUNT(*) AS refundCount,
              COALESCE(SUM(amount), 0) AS refundAmount
       FROM refunds
       WHERE station_id = ? AND status = 'completed' AND date(created_at, '+3 hours') BETWEEN ? AND ?
       GROUP BY businessDate`
    )
    .all(stationId, from, to);

  const paymentMethods = [...new Set(byMethodRows.map((r) => r.paymentMethod))].sort();

  const byMethodByDate = new Map<string, Record<string, number>>();
  for (const r of byMethodRows) {
    const forDay = byMethodByDate.get(r.businessDate) ?? {};
    forDay[r.paymentMethod] = round2(r.netRevenue);
    byMethodByDate.set(r.businessDate, forDay);
  }
  const refundByDate = new Map(refundRows.map((r) => [r.businessDate, r]));

  const allDates = [...new Set([...dayTotals.map((r) => r.businessDate), ...refundRows.map((r) => r.businessDate)])].sort();

  const rows: AccountingExportRow[] = allDates.map((businessDate) => {
    const day = dayTotals.find((r) => r.businessDate === businessDate);
    const refund = refundByDate.get(businessDate);
    const netRevenue = round2(day?.netRevenue ?? 0);
    const { netRevenueExVat, vatAmount } = vatSplit(netRevenue);
    return {
      businessDate,
      transactionCount: day?.transactionCount ?? 0,
      grossRevenue: round2(day?.grossRevenue ?? 0),
      discountAmount: round2(day?.discountAmount ?? 0),
      loyaltyPointsRedeemed: day?.loyaltyPointsRedeemed ?? 0,
      netRevenue,
      vatAmount,
      netRevenueExVat,
      refundCount: refund?.refundCount ?? 0,
      refundAmount: round2(refund?.refundAmount ?? 0),
      byPaymentMethod: byMethodByDate.get(businessDate) ?? {},
    };
  });

  const totals = rows.reduce<AccountingExportTotals>(
    (acc, r) => ({
      transactionCount: acc.transactionCount + r.transactionCount,
      grossRevenue: round2(acc.grossRevenue + r.grossRevenue),
      discountAmount: round2(acc.discountAmount + r.discountAmount),
      loyaltyPointsRedeemed: acc.loyaltyPointsRedeemed + r.loyaltyPointsRedeemed,
      netRevenue: round2(acc.netRevenue + r.netRevenue),
      vatAmount: round2(acc.vatAmount + r.vatAmount),
      netRevenueExVat: round2(acc.netRevenueExVat + r.netRevenueExVat),
      refundCount: acc.refundCount + r.refundCount,
      refundAmount: round2(acc.refundAmount + r.refundAmount),
    }),
    {
      transactionCount: 0,
      grossRevenue: 0,
      discountAmount: 0,
      loyaltyPointsRedeemed: 0,
      netRevenue: 0,
      vatAmount: 0,
      netRevenueExVat: 0,
      refundCount: 0,
      refundAmount: 0,
    }
  );

  return { from, to, paymentMethods, rows, totals };
}
