import { db } from "../db/index.js";
import type { FleetAccountRow, FleetCardTopupRow, FleetPortalUserRow } from "../db/types.js";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";
import { safeCompare } from "../utils/safeCompare.js";
import { getFleetCardTopupConfig } from "./paymentSettingsService.js";
import { IyzicoError, initializeFleetTopupCheckoutForm, retrieveCheckoutForm } from "./iyzicoService.js";
import { topUpFromCardPayment } from "./fleetService.js";

/**
 * Filo portalinda KARTLA ANINDA bakiye yukleme.
 *
 * fleetTopupRequestService.ts'teki "talep" akisindan BILEREK ayri: o akis para
 * tasimaz (personel onayi bekler), bu akis GERCEK bir iyzico tahsilatidir - kiosk
 * odemesiyle AYNI guven modeli (checkout form + sunucu-sunucu retrieve + imza
 * dogrulamasi, bkz. iyzicoService.ts).
 *
 * Komisyon isletmeye YUKLENMEZ (bkz. schema.sql'deki fleet_card_topups yorumu):
 * musteri, sectigi net tutarin uzerine `feePct` kadar bir hizmet bedelini KENDISI
 * karsilar - karttan gross_amount (net+ucret) cekilir, hesaba yalnizca net
 * requested_amount islenir.
 */

export class FleetCardTopupError extends Error {
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

export function getTopupOrThrow(id: number): FleetCardTopupRow {
  const row = db.prepare<[number], FleetCardTopupRow>("SELECT * FROM fleet_card_topups WHERE id = ?").get(id);
  if (!row) throw new FleetCardTopupError("Yukleme bulunamadi.", 404);
  return row;
}

/** Musterinin kendi hesabina ait yukleme gecmisi (portal gorunumu). */
export function listTopupsForAccount(accountId: number, limit = 20): FleetCardTopupRow[] {
  return db
    .prepare<[number, number], FleetCardTopupRow>("SELECT * FROM fleet_card_topups WHERE fleet_account_id = ? ORDER BY id DESC LIMIT ?")
    .all(accountId, limit);
}

export interface StartCardTopupResult {
  topupId: number;
  requestedAmount: number;
  feeAmount: number;
  grossAmount: number;
  checkoutFormContent: string;
  paymentPageUrl: string | null;
}

/**
 * Yuklemeyi baslatir: kaydi 'pending' olarak acar ve iyzico Checkout Form'unu
 * hazirlar. Odeme sonucu, musterinin tarayicisinin iyzico'dan geri dondugu
 * callback ucunda (bkz. finalizeCardTopup) kesinlesir - burasi henuz bakiyeye
 * DOKUNMAZ.
 */
export async function startCardTopup(
  account: FleetAccountRow,
  portalUser: FleetPortalUserRow,
  requestedAmount: number,
  ip: string
): Promise<StartCardTopupResult> {
  if (!(requestedAmount > 0)) throw new FleetCardTopupError("Tutar sifirdan buyuk olmalidir.");
  if (!account.active) throw new FleetCardTopupError("Filo hesabi aktif degil.", 409);

  const config = getFleetCardTopupConfig(account.station_id);
  if (!config.enabled) throw new FleetCardTopupError("Kartla anlik yukleme bu istasyon icin acik degil.", 409);
  if (!env.PUBLIC_API_BASE_URL) {
    throw new FleetCardTopupError("Sunucunun herkese acik adresi tanimlanmamis; kartla yukleme baslatilamaz.", 409);
  }

  const feeAmount = round2(requestedAmount * (config.feePct / 100));
  const grossAmount = round2(requestedAmount + feeAmount);

  const topupId = db
    .prepare(
      `INSERT INTO fleet_card_topups (station_id, fleet_account_id, portal_user_id, requested_amount, fee_amount, gross_amount)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(account.station_id, account.id, portalUser.id, requestedAmount, feeAmount, grossAmount).lastInsertRowid as number;

  try {
    const callbackUrl = `${env.PUBLIC_API_BASE_URL}/api/fleet-portal/card-topups/${topupId}/callback`;
    const result = await initializeFleetTopupCheckoutForm({
      stationId: account.station_id,
      topupId,
      grossAmount,
      companyName: account.company_name,
      buyerEmail: portalUser.email,
      ip,
      callbackUrl,
    });
    db.prepare("UPDATE fleet_card_topups SET iyzico_token = ? WHERE id = ?").run(result.token, topupId);
    return {
      topupId,
      requestedAmount,
      feeAmount,
      grossAmount,
      checkoutFormContent: result.checkoutFormContent,
      paymentPageUrl: result.paymentPageUrl ?? null,
    };
  } catch (err) {
    // Baslatma basarisiz oldu - kayit 'pending' takilip kalmasin, hemen 'failed' isaretlenir.
    db.prepare("UPDATE fleet_card_topups SET status = 'failed' WHERE id = ?").run(topupId);
    if (err instanceof IyzicoError) throw new FleetCardTopupError(err.message, err.status);
    throw err;
  }
}

/**
 * Token'i dogrular (kiosk_access_token ile AYNI desen - bkz. transactionService.ts):
 * yalnizca DOGRU token'a sahip cagiran, ve yalnizca kayit hala 'pending' iken.
 */
function getPendingTopupByToken(id: number, token: string): FleetCardTopupRow {
  const row = getTopupOrThrow(id);
  if (!row.iyzico_token || !safeCompare(row.iyzico_token, token)) {
    throw new FleetCardTopupError("Gecersiz istek.", 403);
  }
  return row;
}

/**
 * iyzico callback'inde cagirilir: sonucu sunucu-sunucu sorgusuyla (retrieveCheckoutForm,
 * imza dogrulamali) teyit edip kaydi kapatir. Basariliysa NET tutar (requested_amount,
 * musteriden alinan hizmet bedeli DAHIL DEGIL) hesaba islenir.
 */
export async function finalizeCardTopup(id: number, token: string): Promise<{ success: boolean }> {
  const row = getPendingTopupByToken(id, token);
  if (row.status !== "pending") {
    // Callback tekrar gelmis olabilir (ör. sayfa yenileme) - idempotent yanit ver.
    return { success: row.status === "paid" };
  }

  const result = await retrieveCheckoutForm(row.station_id, token);
  if (result.conversationId && result.conversationId !== String(id)) {
    throw new FleetCardTopupError("iyzico conversationId uyumsuz.", 502);
  }

  if (!result.success) {
    db.prepare("UPDATE fleet_card_topups SET status = 'failed', payment_reference = ? WHERE id = ?").run(result.paymentId ?? token, id);
    return { success: false };
  }

  const apply = db.transaction(() => {
    topUpFromCardPayment(row.station_id, row.fleet_account_id, row.requested_amount, `Kartla anlik yukleme #${row.id} (iyzico)`);
    db.prepare("UPDATE fleet_card_topups SET status = 'paid', payment_reference = ?, paid_at = ? WHERE id = ?").run(
      result.paymentId ?? token,
      new Date().toISOString(),
      id
    );
  });
  apply();

  logger.info({ topupId: id, accountId: row.fleet_account_id, amount: row.requested_amount }, "Filo portali kartla anlik yukleme tamamlandi.");
  return { success: true };
}

export function serializeCardTopup(t: FleetCardTopupRow) {
  return {
    id: t.id,
    fleetAccountId: t.fleet_account_id,
    requestedAmount: t.requested_amount,
    feeAmount: t.fee_amount,
    grossAmount: t.gross_amount,
    status: t.status,
    createdAt: t.created_at,
    paidAt: t.paid_at,
  };
}
