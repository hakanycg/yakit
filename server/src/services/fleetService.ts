import { db } from "../db/index.js";
import type { FleetAccountRow, FleetMovementRow, FleetPlateRow, UserRow } from "../db/types.js";

export class FleetError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

function normalizePlate(plate: string): string {
  return plate.toUpperCase().replace(/\s+/g, " ").trim();
}

export function listAccounts(stationId: number): FleetAccountRow[] {
  return db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE station_id = ? ORDER BY company_name").all(stationId);
}

export function getAccountById(stationId: number, id: number): FleetAccountRow {
  const row = db.prepare<[number, number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ? AND station_id = ?").get(id, stationId);
  if (!row) throw new FleetError("Filo hesabi bulunamadi.", 404);
  return row;
}

/** Kiosk'ta odeme secenegi olarak gosterilecek: bu plaka aktif bir filo hesabina bagliysa hesabi doner. */
export function getAccountForPlate(stationId: number, plate: string): FleetAccountRow | null {
  const row = db
    .prepare<[number, string], FleetAccountRow>(
      `SELECT fa.* FROM fleet_accounts fa
       JOIN fleet_plates fp ON fp.fleet_account_id = fa.id
       WHERE fa.station_id = ? AND fp.plate = ? AND fa.active = 1`
    )
    .get(stationId, normalizePlate(plate));
  return row ?? null;
}

export function listPlates(accountId: number): FleetPlateRow[] {
  return db.prepare<[number], FleetPlateRow>("SELECT * FROM fleet_plates WHERE fleet_account_id = ? ORDER BY created_at DESC").all(accountId);
}

export interface CreateFleetAccountInput {
  companyName: string;
  vkn?: string;
  billingType: "prepaid" | "postpaid";
  creditLimit?: number;
}

export function createAccount(stationId: number, input: CreateFleetAccountInput, actor: UserRow): FleetAccountRow {
  const result = db
    .prepare(
      `INSERT INTO fleet_accounts (station_id, company_name, vkn, billing_type, credit_limit, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(stationId, input.companyName.trim(), input.vkn?.trim() || null, input.billingType, input.creditLimit ?? null, actor.id);
  return getAccountById(stationId, result.lastInsertRowid as number);
}

export function setAccountActive(stationId: number, id: number, active: boolean): FleetAccountRow {
  const result = db.prepare("UPDATE fleet_accounts SET active = ? WHERE id = ? AND station_id = ?").run(active ? 1 : 0, id, stationId);
  if (result.changes === 0) throw new FleetError("Filo hesabi bulunamadi.", 404);
  return getAccountById(stationId, id);
}

export function addPlate(stationId: number, accountId: number, plate: string): FleetPlateRow {
  getAccountById(stationId, accountId);
  const normalized = normalizePlate(plate);
  try {
    const result = db.prepare("INSERT INTO fleet_plates (fleet_account_id, plate) VALUES (?, ?)").run(accountId, normalized);
    return db.prepare<[number], FleetPlateRow>("SELECT * FROM fleet_plates WHERE id = ?").get(result.lastInsertRowid as number)!;
  } catch {
    throw new FleetError("Bu plaka zaten bu hesaba ekli.", 409);
  }
}

export function removePlate(stationId: number, accountId: number, plateId: number): void {
  getAccountById(stationId, accountId);
  const result = db.prepare("DELETE FROM fleet_plates WHERE id = ? AND fleet_account_id = ?").run(plateId, accountId);
  if (result.changes === 0) throw new FleetError("Plaka bulunamadi.", 404);
}

function insertMovement(params: {
  accountId: number;
  type: FleetMovementRow["type"];
  amount: number;
  balanceAfter: number;
  transactionId?: number | null;
  note?: string | null;
  userId?: number | null;
}): void {
  db.prepare(
    `INSERT INTO fleet_movements (fleet_account_id, type, amount, balance_after, transaction_id, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(params.accountId, params.type, params.amount, params.balanceAfter, params.transactionId ?? null, params.note ?? null, params.userId ?? null);
}

/**
 * Bakiye anlami odeme tipine gore degisir: on odemeli (prepaid) hesapta balance
 * HARCANABILIR bakiyedir (topup arttirir, charge dusurur); sonradan faturalandirma
 * (postpaid) hesapta balance HENUZ FATURALANMAMIS BORCTUR (charge arttirir, topup/
 * odeme kaydi dusurur). Her iki durumda da "kullanilabilir tutar" ayni kavrama
 * karsilik gelir - bkz. getAvailableAmount().
 */
export function getAvailableAmount(account: FleetAccountRow): number {
  if (account.billing_type === "prepaid") return account.balance;
  if (account.credit_limit === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, account.credit_limit - account.balance);
}

/** Yonetici/operator tarafindan bakiye yuklemesi (prepaid) veya borc kapama kaydi (postpaid). */
export function topUp(stationId: number, accountId: number, amount: number, note: string | undefined, actor: UserRow): FleetAccountRow {
  if (amount <= 0) throw new FleetError("Gecersiz tutar.", 400);
  const account = getAccountById(stationId, accountId);
  const newBalance =
    account.billing_type === "prepaid" ? Math.round((account.balance + amount) * 100) / 100 : Math.max(0, Math.round((account.balance - amount) * 100) / 100);

  db.prepare("UPDATE fleet_accounts SET balance = ? WHERE id = ?").run(newBalance, accountId);
  insertMovement({ accountId, type: "topup", amount, balanceAfter: newBalance, note: note ?? null, userId: actor.id });
  return getAccountById(stationId, accountId);
}

/** Kiosk odemesinde filo hesabindan tahsilat yapar. Yetersiz bakiye/limit asimi durumunda hata firlatir. */
export function chargeAccount(stationId: number, accountId: number, amount: number, transactionId: number): FleetAccountRow {
  const account = getAccountById(stationId, accountId);
  if (!account.active) throw new FleetError("Filo hesabi aktif degil.", 409);

  if (account.billing_type === "prepaid") {
    if (account.balance < amount) throw new FleetError("Filo hesabinda yetersiz bakiye.", 409);
  } else if (account.credit_limit !== null && account.balance + amount > account.credit_limit) {
    throw new FleetError("Filo hesabi kredi limiti asilir.", 409);
  }

  const newBalance =
    account.billing_type === "prepaid" ? Math.round((account.balance - amount) * 100) / 100 : Math.round((account.balance + amount) * 100) / 100;

  db.prepare("UPDATE fleet_accounts SET balance = ? WHERE id = ?").run(newBalance, accountId);
  insertMovement({ accountId, type: "charge", amount, balanceAfter: newBalance, transactionId });
  return getAccountById(stationId, accountId);
}

/** Odenmis ama hic yakit dagitilmadan iptal olan bir islemde tahsilati geri alir. */
export function refundCharge(stationId: number, accountId: number, amount: number, transactionId: number): void {
  if (amount <= 0) return;
  const account = getAccountById(stationId, accountId);
  const newBalance =
    account.billing_type === "prepaid" ? Math.round((account.balance + amount) * 100) / 100 : Math.max(0, Math.round((account.balance - amount) * 100) / 100);

  db.prepare("UPDATE fleet_accounts SET balance = ? WHERE id = ?").run(newBalance, accountId);
  insertMovement({ accountId, type: "refund", amount, balanceAfter: newBalance, transactionId, note: "Islem iptal/basarisiz oldugu icin tahsilat iadesi" });
}

/**
 * Bir islemin filo hesabindan GERCEKTE tahsil edilen tutarini geri ceker. Islemin
 * total_amount alanini degil, o tahsilata ait fleet_movements kaydini kaynak alir -
 * cunku dolum baslarken startDispensing() total_amount'u 0'a sifirlar (ilerleme
 * cubugu icin yeniden hesaplanir), yani islem uzerinden orijinal tahsilat tutarina
 * geri donup guvenilir sekilde ulasilamaz.
 */
export function refundChargeForTransaction(transactionId: number): void {
  const movement = db
    .prepare<[number], { fleet_account_id: number; amount: number }>(
      "SELECT fleet_account_id, amount FROM fleet_movements WHERE transaction_id = ? AND type = 'charge' ORDER BY id DESC LIMIT 1"
    )
    .get(transactionId);
  if (!movement) return;
  const account = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(movement.fleet_account_id);
  if (!account) return;
  refundCharge(account.station_id, account.id, movement.amount, transactionId);
}

export function listMovements(stationId: number, accountId: number, limit = 200): (FleetMovementRow & { username: string | null })[] {
  getAccountById(stationId, accountId);
  return db
    .prepare<[number, number], FleetMovementRow & { username: string | null }>(
      `SELECT m.*, u.username as username
       FROM fleet_movements m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.fleet_account_id = ?
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(accountId, Math.min(limit, 1000));
}

export function serializeAccount(a: FleetAccountRow) {
  return {
    id: a.id,
    companyName: a.company_name,
    vkn: a.vkn,
    billingType: a.billing_type,
    balance: a.balance,
    creditLimit: a.credit_limit,
    availableAmount: getAvailableAmount(a) === Number.POSITIVE_INFINITY ? null : getAvailableAmount(a),
    active: !!a.active,
    createdAt: a.created_at,
  };
}

export function serializePlate(p: FleetPlateRow) {
  return { id: p.id, plate: p.plate, createdAt: p.created_at };
}

export function serializeMovement(m: FleetMovementRow & { username?: string | null }) {
  return {
    id: m.id,
    type: m.type,
    amount: m.amount,
    balanceAfter: m.balance_after,
    transactionId: m.transaction_id,
    note: m.note,
    username: m.username ?? null,
    createdAt: m.created_at,
  };
}
