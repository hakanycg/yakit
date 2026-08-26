import { db } from "../db/index.js";
import type { FleetAccountRow, FleetPortalUserRow, FleetTopupRequestRow, UserRow } from "../db/types.js";
import { logger } from "../utils/logger.js";
import { sendEmail, sendSms } from "./notificationService.js";
import { FleetError, topUp } from "./fleetService.js";

/**
 * Filo musterisinin portalden actigi bakiye yukleme talebi.
 *
 * Talep PARA TASIMAZ; bir mesajdir. Bakiye ancak personel onayladiginda ve mevcut
 * topUp() yoluyla artar - para akisi, muhasebe ve komisyon yapisi degismez. Cozdugu
 * sey su: bakiyesi biten sofor gece 2'de istasyonu telefonla aramak zorunda kalmasin.
 *
 * Kartla anlik yukleme bilincli olarak KAPSAM DISI: filo yakit alimi bugun odeme
 * saglayicisina hic ugramiyor (bkz. fleetService.chargeAccount), yani filo cirosunda
 * komisyon yok. Yuklemeyi karta baglamak, komisyonu hacmin %0'indan %100'une tasirdi -
 * bu teknik degil ticari bir karardir ve isletmenindir.
 */

export class TopupRequestError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** Ayni hesapta ayni anda yalnizca BIR acik talep olabilir. */
function openRequestFor(accountId: number): FleetTopupRequestRow | undefined {
  return db
    .prepare<[number], FleetTopupRequestRow>(
      "SELECT * FROM fleet_topup_requests WHERE fleet_account_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
    )
    .get(accountId);
}

export function createRequest(
  account: FleetAccountRow,
  portalUser: FleetPortalUserRow,
  amount: number,
  note: string | undefined
): FleetTopupRequestRow {
  if (!(amount > 0)) throw new TopupRequestError("Tutar sifirdan buyuk olmalidir.");
  if (!account.active) throw new TopupRequestError("Filo hesabi aktif degil.", 409);
  // Ust uste talep, nobetci personele gereksiz bildirim yagdirir ve hangisinin
  // gecerli oldugunu belirsizlestirir. Musteri once acik talebini iptal etmeli.
  if (openRequestFor(account.id)) {
    throw new TopupRequestError("Bu hesap icin zaten bekleyen bir yukleme talebi var.", 409);
  }

  const id = db
    .prepare(
      `INSERT INTO fleet_topup_requests (station_id, fleet_account_id, portal_user_id, requested_amount, note)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(account.station_id, account.id, portalUser.id, amount, note?.trim() || null).lastInsertRowid as number;

  notifyStaff(account, amount, note);
  return getRequestOrThrow(id);
}

/**
 * Talebi nobetci personele ulastirir. Bildirim gonderimi TALEBIN KAYDINI ETKILEMEZ:
 * SMTP/SMS yapilandirilmamis ya da erisilemez olsa bile talep panelde durur ve
 * personel oradan gorur - bildirim bir kolaylik, tek kanal degil.
 */
function notifyStaff(account: FleetAccountRow, amount: number, note: string | undefined): void {
  const recipients = db
    .prepare<[number], { email: string | null; phone: string | null; notify_email: 0 | 1; notify_sms: 0 | 1 }>(
      `SELECT email, phone, notify_email, notify_sms FROM users
        WHERE station_id = ? AND active = 1`
    )
    .all(account.station_id);

  const subject = `[Bakiye Yukleme Talebi] ${account.company_name}`;
  const body =
    `${account.company_name} filo hesabi icin ${amount.toFixed(2)} TL bakiye yuklemesi talep etti.` +
    (note?.trim() ? ` Musteri notu: ${note.trim()}` : "") +
    " Panelden Filo Hesaplari > bekleyen talepler bolumunden onaylayabilirsiniz.";

  for (const r of recipients) {
    if (r.notify_email && r.email) {
      sendEmail(r.email, subject, body).catch((err) =>
        logger.error({ err, accountId: account.id }, "Filo yukleme talebi e-postasi gonderilemedi.")
      );
    }
    if (r.notify_sms && r.phone) {
      sendSms(r.phone, `${subject}: ${amount.toFixed(2)} TL`).catch((err) =>
        logger.error({ err, accountId: account.id }, "Filo yukleme talebi SMS'i gonderilemedi.")
      );
    }
  }
}

export function getRequestOrThrow(id: number): FleetTopupRequestRow {
  const row = db.prepare<[number], FleetTopupRequestRow>("SELECT * FROM fleet_topup_requests WHERE id = ?").get(id);
  if (!row) throw new TopupRequestError("Yukleme talebi bulunamadi.", 404);
  return row;
}

/** Musterinin kendi hesabina ait talepleri (portal gorunumu). */
export function listRequestsForAccount(accountId: number, limit = 20): FleetTopupRequestRow[] {
  return db
    .prepare<[number, number], FleetTopupRequestRow>(
      "SELECT * FROM fleet_topup_requests WHERE fleet_account_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(accountId, limit);
}

/** Istasyondaki bekleyen talepler (panel gorunumu). */
export function listPendingForStation(stationId: number): Array<FleetTopupRequestRow & { company_name: string; email: string }> {
  return db
    .prepare<[number], FleetTopupRequestRow & { company_name: string; email: string }>(
      `SELECT r.*, a.company_name, u.email
         FROM fleet_topup_requests r
         JOIN fleet_accounts a ON a.id = r.fleet_account_id
         JOIN fleet_portal_users u ON u.id = r.portal_user_id
        WHERE r.station_id = ? AND r.status = 'pending'
        ORDER BY r.id ASC`
    )
    .all(stationId);
}

function assertPending(request: FleetTopupRequestRow, stationId: number): void {
  if (request.station_id !== stationId) throw new TopupRequestError("Yukleme talebi bulunamadi.", 404);
  // Idempotanlik: iki kez onaylanan bir talep bakiyeyi iki kez artirirdi.
  if (request.status !== "pending") throw new TopupRequestError("Bu talep zaten sonuclandirilmis.", 409);
}

/**
 * Onay: bakiye personelin FIILEN TAHSIL ETTIGI tutar kadar artar.
 *
 * Musterinin talep ettigi tutar bir niyet beyanidir; kasaya giren para eksik havale
 * ya da farkli bir tutar olabilir. Talebi otomatik olarak talep edilen tutarla
 * kapatmak, hic gelmemis parayi bakiyeye yazmak demek olurdu.
 */
export function approveRequest(
  requestId: number,
  stationId: number,
  actor: UserRow,
  input: { amount: number; note?: string }
): { request: FleetTopupRequestRow; account: FleetAccountRow } {
  const request = getRequestOrThrow(requestId);
  assertPending(request, stationId);
  if (!(input.amount > 0)) throw new TopupRequestError("Tahsil edilen tutar sifirdan buyuk olmalidir.");

  const apply = db.transaction(() => {
    const note = input.note?.trim() || `Portal talebi #${request.id}`;
    let account: FleetAccountRow;
    try {
      account = topUp(stationId, request.fleet_account_id, input.amount, note, actor);
    } catch (err) {
      if (err instanceof FleetError) throw new TopupRequestError(err.message, err.status);
      throw err;
    }
    db.prepare(
      `UPDATE fleet_topup_requests
          SET status = 'approved', approved_amount = ?, handled_by = ?, handled_at = ?, handled_note = ?
        WHERE id = ?`
    ).run(input.amount, actor.id, new Date().toISOString(), input.note?.trim() || null, request.id);
    return account;
  });

  const account = apply();
  return { request: getRequestOrThrow(requestId), account };
}

export function rejectRequest(requestId: number, stationId: number, actor: UserRow, note?: string): FleetTopupRequestRow {
  const request = getRequestOrThrow(requestId);
  assertPending(request, stationId);
  db.prepare(
    `UPDATE fleet_topup_requests
        SET status = 'rejected', handled_by = ?, handled_at = ?, handled_note = ?
      WHERE id = ?`
  ).run(actor.id, new Date().toISOString(), note?.trim() || null, request.id);
  return getRequestOrThrow(requestId);
}

/** Musteri kendi bekleyen talebini geri cekebilir (ör. yanlis tutar girdiyse). */
export function cancelOwnRequest(requestId: number, accountId: number): void {
  const request = getRequestOrThrow(requestId);
  if (request.fleet_account_id !== accountId) throw new TopupRequestError("Yukleme talebi bulunamadi.", 404);
  if (request.status !== "pending") throw new TopupRequestError("Bu talep zaten sonuclandirilmis.", 409);
  db.prepare("DELETE FROM fleet_topup_requests WHERE id = ?").run(requestId);
}

export function serializeRequest(r: FleetTopupRequestRow & { company_name?: string; email?: string }) {
  return {
    id: r.id,
    fleetAccountId: r.fleet_account_id,
    companyName: r.company_name,
    portalUserEmail: r.email,
    requestedAmount: r.requested_amount,
    approvedAmount: r.approved_amount,
    note: r.note,
    status: r.status,
    handledAt: r.handled_at,
    handledNote: r.handled_note,
    createdAt: r.created_at,
  };
}

/**
 * Hesabi YALNIZCA kimlikle yukler - istasyon kapsami olmadan.
 *
 * Portal istasyon kapsamli degildir: bir portal kullanicisi birden fazla istasyonda
 * hesap sahibi olabilir. Erisim kontrolu zaten cagiran tarafta yapiliyor
 * (assertAccountAccess, bkz. routes/fleetPortal.ts) - burada istasyon kimligi
 * istemek, dogru hesabi bile 404'e dusururdu. Bu fonksiyon SADECE erisimi
 * dogrulanmis bir hesap kimligiyle cagrilmalidir.
 */
export function accountForVerifiedAccess(accountId: number): FleetAccountRow {
  const row = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(accountId);
  if (!row) throw new TopupRequestError("Filo hesabi bulunamadi.", 404);
  return row;
}
