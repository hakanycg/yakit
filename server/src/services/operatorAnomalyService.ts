import { db } from "../db/index.js";

/**
 * Personel bazli indirim/iptal anomali raporu (bkz. arastirma bulgusu: vardiya ozeti
 * ciro/litre veriyor ama personelin indirim kullanim orani, iptal/red edilen islem
 * orani gibi "olagandisi" davranislari one cikaran bir kiyaslama yok - ic
 * kontrol/usulsuzluk tespiti icin degerli olur).
 *
 * "Anomali" ISTATISTIKSEL bir yargidir, SUCLAMA degildir: bir personelin indirim/iptal
 * orani istasyon ortalamasinin BELIRGIN uzerindeyse (esik + asgari islem sayisi ile,
 * kucuk orneklemde tesadufi sapmayi anomali saymamak icin) isaretlenir - nedeni
 * (usulsuzluk mu, zor musteriler mi, egitim eksikligi mi) yalnizca yerinde incelemeyle
 * anlasilir.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Bir oranin istasyon ortalamasinin bu kat kadar uzerinde olmasi anomali sayilir. */
const ANOMALY_MULTIPLIER = 1.5;
/** Bu esikten az islemi olan personel icin oran hesaplanir ama anomali ISARETLENMEZ - kucuk orneklemde %100 iptal orani (1 islemde 1 iptal) yaniltici olurdu. */
const MIN_SAMPLE_SIZE = 10;

export interface OperatorAnomalyRow {
  userId: number;
  username: string;
  totalCount: number;
  cancelledCount: number;
  cancelRatePct: number;
  discountedCount: number;
  discountRatePct: number;
  totalDiscountAmount: number;
  isCancelRateAnomaly: boolean;
  isDiscountRateAnomaly: boolean;
}

export function getOperatorAnomalyReport(stationId: number, from?: string, to?: string): OperatorAnomalyRow[] {
  const clauses = ["t.station_id = ?", "t.operator_user_id IS NOT NULL"];
  const params: (string | number)[] = [stationId];
  if (from) {
    clauses.push("t.created_at >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("t.created_at <= ?");
    params.push(`${to}T23:59:59.999Z`);
  }
  const where = clauses.join(" AND ");

  const rows = db
    .prepare<(string | number)[], {
      userId: number;
      username: string;
      totalCount: number;
      cancelledCount: number;
      discountedCount: number;
      totalDiscountAmount: number;
    }>(
      `SELECT u.id as userId, u.username as username,
              COUNT(*) as totalCount,
              SUM(CASE WHEN t.status = 'cancelled' THEN 1 ELSE 0 END) as cancelledCount,
              SUM(CASE WHEN t.discount_amount > 0 THEN 1 ELSE 0 END) as discountedCount,
              COALESCE(SUM(t.discount_amount), 0) as totalDiscountAmount
       FROM transactions t
       JOIN users u ON u.id = t.operator_user_id
       WHERE ${where}
       GROUP BY u.id`
    )
    .all(...params);

  if (rows.length === 0) return [];

  const totalAll = rows.reduce((sum, r) => sum + r.totalCount, 0);
  const cancelledAll = rows.reduce((sum, r) => sum + r.cancelledCount, 0);
  const discountedAll = rows.reduce((sum, r) => sum + r.discountedCount, 0);
  const stationCancelRate = totalAll > 0 ? cancelledAll / totalAll : 0;
  const stationDiscountRate = totalAll > 0 ? discountedAll / totalAll : 0;

  return rows
    .map((r) => {
      const cancelRate = r.totalCount > 0 ? r.cancelledCount / r.totalCount : 0;
      const discountRate = r.totalCount > 0 ? r.discountedCount / r.totalCount : 0;
      const enoughSample = r.totalCount >= MIN_SAMPLE_SIZE;
      return {
        userId: r.userId,
        username: r.username,
        totalCount: r.totalCount,
        cancelledCount: r.cancelledCount,
        cancelRatePct: round2(cancelRate * 100),
        discountedCount: r.discountedCount,
        discountRatePct: round2(discountRate * 100),
        totalDiscountAmount: round2(r.totalDiscountAmount),
        isCancelRateAnomaly: enoughSample && stationCancelRate > 0 && cancelRate > stationCancelRate * ANOMALY_MULTIPLIER,
        isDiscountRateAnomaly: enoughSample && stationDiscountRate > 0 && discountRate > stationDiscountRate * ANOMALY_MULTIPLIER,
      };
    })
    .sort((a, b) => Number(b.isCancelRateAnomaly || b.isDiscountRateAnomaly) - Number(a.isCancelRateAnomaly || a.isDiscountRateAnomaly) || b.totalCount - a.totalCount);
}
