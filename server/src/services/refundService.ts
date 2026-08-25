import { db } from "../db/index.js";
import type { RefundRow, TransactionRow, UserRow } from "../db/types.js";
import { chargeAmount } from "./transactionService.js";
import { refundPayment } from "./iyzicoService.js";
import { isIyzicoReady } from "./paymentSettingsService.js";
import { refundCharge as refundFleetCharge } from "./fleetService.js";
import { adjustPoints, getBalance } from "./loyaltyService.js";
import { logger } from "../utils/logger.js";

/**
 * Iade (refund).
 *
 * Sistemde para iade etmenin HICBIR yolu yoktu. Tahsil edilmis bir odeme yalnizca
 * iyzico panelinden elle iade edilebiliyordu ve bizde izi kalmiyordu: gun sonu kasasi
 * geri gonderilen parayi ciroda saymaya devam ediyor, musteriye bir teyit gitmiyor,
 * denetim izinde hicbir sey gorunmuyordu.
 *
 * Personelsiz istasyonda bu bosluk daha da agirdir: "odedim ama yakit akmadi" diyen
 * musteriye yerinde cozum uretecek bir gorevli yoktur; tek cozum sistemin kendisidir.
 *
 * IADE KENDI BASINA BIR OLAYDIR, islem uzerinde bir bayrak degil (bkz. refunds tablosu):
 * kismi iade edilebilmesi ve KESILDIGI gunun kasasina yazilmasi ancak boyle mumkun olur.
 */

export class RefundError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function getTransaction(stationId: number, transactionId: number): TransactionRow {
  const t = db
    .prepare<[number, number], TransactionRow>("SELECT * FROM transactions WHERE id = ? AND station_id = ?")
    .get(transactionId, stationId);
  // Erisilemeyen islem ile var olmayan islem ayni cevabi dondurur.
  if (!t) throw new RefundError("Islem bulunamadi.", 404);
  return t;
}

/** Bu isleme daha once yapilmis BASARILI iadelerin toplami. */
export function refundedTotal(transactionId: number): number {
  const row = db
    .prepare<[number], { total: number }>(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE transaction_id = ? AND status = 'completed'"
    )
    .get(transactionId)!;
  return round2(row.total);
}

/**
 * Bir islem kumesinin iade toplamlari, TEK sorguda.
 *
 * Islem listesi ekrani her satir icin ayri istek atmasin diye: 1000 satirlik bir liste
 * 1000 istek demek olurdu ve iade bilgisi listede zaten yalnizca ozet olarak gorunuyor.
 */
export function refundedTotalsFor(transactionIds: number[]): Map<number, number> {
  const totals = new Map<number, number>();
  if (transactionIds.length === 0) return totals;
  // SQLite degisken siniri (varsayilan 999) asilmasin diye parcalara bolunur.
  for (let i = 0; i < transactionIds.length; i += 500) {
    const chunk = transactionIds.slice(i, i + 500);
    const rows = db
      .prepare<number[], { transaction_id: number; total: number }>(
        `SELECT transaction_id, COALESCE(SUM(amount), 0) AS total
         FROM refunds
         WHERE status = 'completed' AND transaction_id IN (${chunk.map(() => "?").join(",")})
         GROUP BY transaction_id`
      )
      .all(...chunk);
    for (const r of rows) totals.set(r.transaction_id, round2(r.total));
  }
  return totals;
}

export interface RefundableInfo {
  chargedAmount: number;
  refundedAmount: number;
  refundableAmount: number;
  refundable: boolean;
  reason: string | null;
}

/**
 * Bu islem iade edilebilir mi, ne kadari?
 *
 * Yalnizca GERCEKTEN TAHSIL EDILMIS bir para iade edilebilir. Odemesi alinmamis
 * (authorized/pending) bir islemde iade degil IPTAL gerekir - blokaj bankada zaten
 * kendiliginden serbest kalir (bkz. iyzicoService.capturePostAuth).
 */
export function getRefundableInfo(stationId: number, transactionId: number): RefundableInfo {
  const t = getTransaction(stationId, transactionId);
  const charged = chargeAmount(t);
  const refunded = refundedTotal(transactionId);
  const refundable = round2(charged - refunded);

  let reason: string | null = null;
  if (t.payment_status !== "captured" && t.payment_status !== "refunded") {
    reason = "Yalnizca tahsil edilmis odemeler iade edilebilir.";
  } else if (charged <= 0) {
    reason = "Bu islemde tahsil edilmis bir tutar yok.";
  } else if (refundable <= 0) {
    reason = "Bu islemin tamami zaten iade edilmis.";
  }

  return { chargedAmount: charged, refundedAmount: refunded, refundableAmount: Math.max(0, refundable), refundable: reason === null, reason };
}

/**
 * Sadakat puanini geri alir.
 *
 * Iade edilen bir dolumdan puan kazanilmis kalmasi, musteriye iki kez odeme yapmak olur.
 * Kismi iadede puan ORANTILI dusulur. Bakiyesi yetmiyorsa (puan harcanmis olabilir)
 * bakiye sifira cekilir - eksiye dusurmek, musteriyi bir sonraki alisverisinde
 * borclandirmak demek olurdu ve bunun karsiligi yok.
 */
function clawBackLoyalty(t: TransactionRow, refundRatio: number, actor: UserRow): void {
  if (t.loyalty_points_earned <= 0) return;
  const clawBack = round2(t.loyalty_points_earned * refundRatio);
  if (clawBack <= 0) return;

  try {
    const balance = getBalance(t.station_id, t.plate);
    const next = Math.max(0, round2(balance - clawBack));
    const taken = round2(balance - next);
    // Bakiye zaten sifirsa yazacak bir sey yok: "25 puan geri alindi" diyen ama hicbir
    // seyi degistirmeyen bir hareket, defteri okuyani yaniltir.
    if (taken <= 0) return;
    const note =
      taken < clawBack
        ? `Iade: islem #${t.id} (${clawBack} puandan ${taken} puani geri alinabildi, bakiye yetersiz)`
        : `Iade: islem #${t.id} (${taken} puan geri alindi)`;
    adjustPoints(t.station_id, t.plate, next, note, actor);
  } catch (err) {
    // Puan geri alinamazsa iade YINE DE gecerlidir: musterinin parasi iade edilmistir ve
    // bunu puan yuzunden geri almak dogru olmaz. Kayda gecirilir, elle duzeltilebilir.
    logger.error({ err, transactionId: t.id }, "Iade sonrasi sadakat puani geri alinamadi.");
  }
}

export interface RefundInput {
  /** Iade edilecek tutar. Verilmezse kalan tutarin TAMAMI iade edilir. */
  amount?: number;
  reason: string;
  ip?: string;
}

/**
 * Iadeyi yapar ve kaydeder.
 *
 * Odeme yontemine gore yonlendirilir:
 *  - iyzico: gercek iade cagrisi (para karta doner).
 *  - fleet:  filo hesabina geri yuklenir (mevcut refundCharge).
 *  - diger:  sanal POS simulasyonu; kayit yeterlidir.
 *
 * Saglayici cagrisi BASARISIZ olursa kayit 'failed' olarak durur ve islem
 * DEGISTIRILMEZ: para hala musteride degildir, "iade edildi" demek yanlis olurdu.
 */
export async function refundTransaction(
  stationId: number,
  transactionId: number,
  input: RefundInput,
  actor: UserRow
): Promise<RefundRow & { username: string | null }> {
  const t = getTransaction(stationId, transactionId);
  const info = getRefundableInfo(stationId, transactionId);
  if (!info.refundable) throw new RefundError(info.reason ?? "Bu islem iade edilemez.", 409);

  const amount = round2(input.amount ?? info.refundableAmount);
  if (!(amount > 0)) throw new RefundError("Iade tutari sifirdan buyuk olmalidir.", 400);
  if (amount > info.refundableAmount) {
    throw new RefundError(
      `Iade tutari kalan iade edilebilir tutari (${info.refundableAmount} TL) asamaz.`,
      409
    );
  }
  if (!input.reason.trim()) throw new RefundError("Iade gerekcesi zorunludur.", 400);

  let providerRefundId: string | null = null;

  if (t.payment_method === "iyzico") {
    if (!t.payment_reference) throw new RefundError("Bu islemde iyzico odeme referansi yok; iade yapilamaz.", 409);
    if (!isIyzicoReady(stationId).ready) throw new RefundError("iyzico yapilandirilmamis; iade yapilamaz.", 409);
    try {
      providerRefundId = (await refundPayment(stationId, t.id, t.payment_reference, amount, input.ip)).refundId;
    } catch (err) {
      // Basarisiz denemeyi de kaydet: "iade denendi mi?" sorusunun cevabi, musteri
      // tekrar aradiginda aranan ilk seydir.
      const message = err instanceof Error ? err.message : "Bilinmeyen hata";
      db.prepare(
        `INSERT INTO refunds (station_id, transaction_id, amount, reason, payment_method, status, error_message, user_id)
         VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)`
      ).run(stationId, transactionId, amount, input.reason.trim(), t.payment_method, message, actor.id);
      logger.error({ err, transactionId }, "Iade saglayici tarafinda basarisiz oldu.");
      throw new RefundError(`Iade yapilamadi: ${message}`, 502);
    }
  } else if (t.payment_method === "fleet") {
    // Filo hesabina geri yukleme zaten mevcut; iade burada da ayni yoldan gecer ki
    // bakiye ile hareket defteri birbirinden ayrilmasin.
    const movement = db
      .prepare<[number], { fleet_account_id: number }>(
        "SELECT fleet_account_id FROM fleet_movements WHERE transaction_id = ? AND type = 'charge' ORDER BY id DESC LIMIT 1"
      )
      .get(transactionId);
    if (!movement) throw new RefundError("Bu islemin filo tahsilat kaydi bulunamadi.", 409);
    refundFleetCharge(stationId, movement.fleet_account_id, amount, transactionId);
  }

  const refundId = db
    .prepare(
      `INSERT INTO refunds (station_id, transaction_id, amount, reason, payment_method, provider_refund_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(stationId, transactionId, amount, input.reason.trim(), t.payment_method, providerRefundId, actor.id)
    .lastInsertRowid as number;

  // payment_status yalnizca TAMAMI iade edildiginde degisir. Kismi iadede islem hala
  // tahsil edilmis durumdadir; farki refunds tablosu tasir.
  if (round2(info.refundedAmount + amount) >= info.chargedAmount) {
    db.prepare("UPDATE transactions SET payment_status = 'refunded' WHERE id = ?").run(transactionId);
  }

  clawBackLoyalty(t, amount / info.chargedAmount, actor);

  // Kullanici adiyla birlikte doner: cagiran taraf listeyle ayni sekli gormeli, yoksa
  // iadeyi yapan kisi yeni kayitta bos gorunur.
  return db
    .prepare<[number], RefundRow & { username: string | null }>(
      "SELECT r.*, u.username AS username FROM refunds r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?"
    )
    .get(refundId)!;
}

export function listRefunds(stationId: number, transactionId: number): (RefundRow & { username: string | null })[] {
  getTransaction(stationId, transactionId);
  return db
    .prepare<[number], RefundRow & { username: string | null }>(
      `SELECT r.*, u.username AS username
       FROM refunds r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.transaction_id = ? ORDER BY r.created_at DESC`
    )
    .all(transactionId);
}

export function serializeRefund(r: RefundRow & { username?: string | null }) {
  return {
    id: r.id,
    transactionId: r.transaction_id,
    amount: r.amount,
    reason: r.reason,
    paymentMethod: r.payment_method,
    providerRefundId: r.provider_refund_id,
    status: r.status,
    errorMessage: r.error_message,
    username: r.username ?? null,
    createdAt: r.created_at,
  };
}
