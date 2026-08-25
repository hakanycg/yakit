import { db } from "../db/index.js";
import type { UserRow } from "../db/types.js";

/**
 * Gun sonu kasa/odeme mutabakati.
 *
 * Sistemin kaydina gore "su kadar tahsil edilmis olmali" ile banka/POS ekstresine
 * GERCEKTEN gecen tutar karsilastirilir. Yakit sapmasiyla ayni mantik: orada kayit
 * stogu fiziksel olcumle sinaniyor, burada kayit tahsilati parayla sinaniyor.
 *
 * iyzico'nun hakedis/ekstre raporunu cekecek bir ucu yok (bkz. iyzicoService.ts -
 * yalnizca checkout, capture ve iptal var), bu yuzden gerceklesen tutar ELLE girilir.
 * Bu bir eksiklik degil bilincli sinir: mutabakatin anlami zaten "sistemin disindaki
 * bir kaynagi sisteme karsi dogrulamak"tir; sayiyi da sistemin kendisi uretirse
 * mutabakat yapilmis olmaz.
 */

export class ReconciliationError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/**
 * Is gunu siniri. Turkiye 2016'dan beri yil boyu UTC+3'tur (yaz saati uygulamasi yok),
 * bu yuzden sabit ofset dogru sonuc verir.
 *
 * Bu ONEMLI: UTC tarihine gore gruplamak gunu yerel saatle 03:00'te bolerdi ve gece
 * 01:30'daki bir satis bir onceki gunun kasasina yazilirdi - kasayi kapatan kisi
 * ekstresiyle tutmayan bir rakam gorurdu.
 */
const BUSINESS_DAY_OFFSET = "+3 hours";

/** Bir islemin hangi is gunune ait sayilacagi: para, islem tamamlandiginda hareket eder. */
const DAY_ANCHOR = "COALESCE(completed_at, created_at)";

export function currentBusinessDate(now = new Date()): string {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface PaymentMethodRow {
  paymentMethod: string;
  count: number;
  amount: number;
}

export interface FuelRow {
  fuelType: string;
  count: number;
  liters: number;
  amount: number;
}

export interface PendingTransaction {
  id: number;
  plate: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  amount: number;
  createdAt: string;
}

export interface DaySummary {
  businessDate: string;
  transactionCount: number;
  grossAmount: number;
  discountAmount: number;
  /**
   * Tahsil edilmis tutar: brut - indirim/puan kullanimi. IADE EDILEN islemler de bu
   * toplama DAHILDIR - cunku kart o gun gercekten cekilmistir ve ekstrede oyle gorunur.
   * Iadenin ne zaman hesaba yansiyacagi saglayiciya/bankaya gore degistiginden, iade
   * tutari ayrica asagida raporlanir ve operator farki ona bakarak aciklar.
   */
  expectedTotal: number;
  /** expectedTotal icindeki, sonradan iade edilmis tutar. */
  refundedAmount: number;
  refundedCount: number;
  byPaymentMethod: PaymentMethodRow[];
  byFuelType: FuelRow[];
  /**
   * Mutabakatsizligin gercek kaynagi genelde burasidir: parasi bloke edilmis ama
   * tamamlanmamis, ya da tahsilati basarisiz olmus islemler.
   */
  pending: PendingTransaction[];
  closed: ReconciliationRecord | null;
}

export interface ReconciliationRecord {
  id: number;
  businessDate: string;
  expectedTotal: number;
  declaredTotal: number;
  difference: number;
  pendingCount: number;
  breakdown: PaymentMethodRow[];
  note: string | null;
  closedAt: string;
  closedBy: string | null;
}

interface ReconciliationRow {
  id: number;
  business_date: string;
  expected_total: number;
  declared_total: number;
  difference: number;
  pending_count: number;
  breakdown_json: string;
  note: string | null;
  closed_at: string;
  username: string | null;
}

function serializeRecord(r: ReconciliationRow): ReconciliationRecord {
  let breakdown: PaymentMethodRow[] = [];
  try {
    breakdown = JSON.parse(r.breakdown_json) as PaymentMethodRow[];
  } catch {
    // Bozuk bir fotograf, kaydin tamamini kullanilamaz yapmamali: rakamlar zaten
    // kendi kolonlarinda duruyor, yalnizca kirilim gosterilemez.
    breakdown = [];
  }
  return {
    id: r.id,
    businessDate: r.business_date,
    expectedTotal: r.expected_total,
    declaredTotal: r.declared_total,
    difference: r.difference,
    pendingCount: r.pending_count,
    breakdown,
    note: r.note,
    closedAt: r.closed_at,
    closedBy: r.username,
  };
}

export function getClosedDay(stationId: number, businessDate: string): ReconciliationRecord | null {
  const row = db
    .prepare<[number, string], ReconciliationRow>(
      `SELECT r.*, u.username AS username
       FROM daily_reconciliations r
       LEFT JOIN users u ON u.id = r.closed_by
       WHERE r.station_id = ? AND r.business_date = ?`
    )
    .get(stationId, businessDate);
  return row ? serializeRecord(row) : null;
}

export function getDaySummary(stationId: number, businessDate: string): DaySummary {
  const params: [number, string] = [stationId, businessDate];
  const dayFilter = `station_id = ? AND date(${DAY_ANCHOR}, '${BUSINESS_DAY_OFFSET}') = ?`;

  const totals = db
    .prepare<[number, string], { count: number; gross: number; discount: number }>(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(total_amount), 0) AS gross,
              COALESCE(SUM(discount_amount), 0) AS discount
       FROM transactions
       WHERE ${dayFilter} AND status = 'completed'`
    )
    .get(...params)!;

  const byPaymentMethod = db
    .prepare<[number, string], PaymentMethodRow>(
      `SELECT payment_method AS paymentMethod,
              COUNT(*) AS count,
              ROUND(COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0), 2) AS amount
       FROM transactions
       WHERE ${dayFilter} AND status = 'completed'
       GROUP BY payment_method
       ORDER BY amount DESC`
    )
    .all(...params);

  const byFuelType = db
    .prepare<[number, string], FuelRow>(
      `SELECT fuel_type AS fuelType,
              COUNT(*) AS count,
              ROUND(COALESCE(SUM(dispensed_liters), 0), 2) AS liters,
              ROUND(COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0), 2) AS amount
       FROM transactions
       WHERE ${dayFilter} AND status = 'completed'
       GROUP BY fuel_type
       ORDER BY amount DESC`
    )
    .all(...params);

  const pending = db
    .prepare<[number, string], PendingTransaction>(
      `SELECT id, plate, status,
              payment_method AS paymentMethod,
              payment_status AS paymentStatus,
              ROUND(MAX(0, total_amount - discount_amount), 2) AS amount,
              created_at AS createdAt
       FROM transactions
       WHERE ${dayFilter}
         AND (
           -- Parasi bloke edilmis ama is bitmemis: musteri odedi, yakit akmadi.
           (payment_status IN ('authorized', 'processing') AND status != 'completed')
           -- Tahsilat basarisiz ya da iade edilmis: ekstredeki tutari dogrudan etkiler.
           OR payment_status IN ('failed', 'refunded')
         )
       ORDER BY created_at ASC`
    )
    .all(...params);

  const refunded = db
    .prepare<[number, string], { count: number; amount: number }>(
      `SELECT COUNT(*) AS count,
              ROUND(COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0), 2) AS amount
       FROM transactions
       WHERE ${dayFilter} AND status = 'completed' AND payment_status = 'refunded'`
    )
    .get(...params)!;

  return {
    businessDate,
    transactionCount: totals.count,
    refundedAmount: refunded.amount,
    refundedCount: refunded.count,
    grossAmount: round2(totals.gross),
    discountAmount: round2(totals.discount),
    expectedTotal: round2(byPaymentMethod.reduce((sum, r) => sum + r.amount, 0)),
    byPaymentMethod,
    byFuelType,
    pending,
    closed: getClosedDay(stationId, businessDate),
  };
}

export interface CloseDayInput {
  stationId: number;
  businessDate: string;
  declaredTotal: number;
  note?: string | null;
  actor: UserRow;
}

/**
 * Gunu kapatir: o anki hesaplanan tutari, beyan edilen tutari ve farki kalici olarak
 * kaydeder. Kirilim fotograf olarak saklanir - sonradan gelen bir iade, kapatilmis
 * gunun rakamini geriye donuk degistirmemelidir.
 */
export function closeDay(input: CloseDayInput): ReconciliationRecord {
  const { stationId, businessDate, declaredTotal, actor } = input;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new ReconciliationError("Gecersiz tarih bicimi (YYYY-MM-DD bekleniyor).", 400);
  }
  if (!Number.isFinite(declaredTotal) || declaredTotal < 0) {
    throw new ReconciliationError("Gerceklesen tutar negatif olamaz.", 400);
  }
  // Henuz bitmemis bir gunun kasasi kapatilamaz: gunun geri kalaninda gelecek satislar
  // kapanmis rakamin disinda kalir ve mutabakat sessizce yanlis olur.
  if (businessDate > currentBusinessDate()) {
    throw new ReconciliationError("Gelecek bir tarihin kasasi kapatilamaz.", 400);
  }
  if (getClosedDay(stationId, businessDate)) {
    throw new ReconciliationError("Bu gunun kasasi zaten kapatilmis.", 409);
  }

  const summary = getDaySummary(stationId, businessDate);
  const difference = round2(declaredTotal - summary.expectedTotal);

  db.prepare(
    `INSERT INTO daily_reconciliations
       (station_id, business_date, expected_total, declared_total, difference,
        breakdown_json, pending_count, note, closed_by, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    stationId,
    businessDate,
    summary.expectedTotal,
    round2(declaredTotal),
    difference,
    JSON.stringify(summary.byPaymentMethod),
    summary.pending.length,
    input.note?.trim() || null,
    actor.id,
    new Date().toISOString()
  );

  return getClosedDay(stationId, businessDate)!;
}

export function listReconciliations(stationId: number, limit = 60): ReconciliationRecord[] {
  const capped = Math.min(Math.max(limit, 1), 365);
  return db
    .prepare<[number, number], ReconciliationRow>(
      `SELECT r.*, u.username AS username
       FROM daily_reconciliations r
       LEFT JOIN users u ON u.id = r.closed_by
       WHERE r.station_id = ?
       ORDER BY r.business_date DESC
       LIMIT ?`
    )
    .all(stationId, capped)
    .map(serializeRecord);
}
