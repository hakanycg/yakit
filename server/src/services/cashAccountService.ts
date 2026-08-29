import { db } from "../db/index.js";
import type { CashAccountMovementRow, CashAccountRow, UserRow } from "../db/types.js";

/**
 * Kasa/Banka hesabi (on muhasebe, 3. modul).
 *
 * Platform personelsiz - kiosk'ta hicbir nakit odeme yontemi yok, bu yuzden bu
 * bir fiziksel kasa/vardiya defteri DEGIL. Gun Sonu Mutabakati (reconciliationService)
 * o gunun satis gelirinin banka/POS ekstresiyle eslestigini dogruluyor ama hicbir
 * zaman bir bakiye TUTMUYOR. Burasi, isletme sahibinin kendi banka/nakit
 * hesaplarinin elle tuttugu, gunler arasi tasinan bir bakiye defteri.
 */

export class CashAccountError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export const ACCOUNT_KINDS = ["bank", "cash"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const MOVEMENT_DIRECTIONS = ["in", "out"] as const;
export type MovementDirection = (typeof MOVEMENT_DIRECTIONS)[number];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function getAccount(stationId: number, id: number): CashAccountRow {
  const row = db.prepare<[number, number], CashAccountRow>("SELECT * FROM cash_accounts WHERE id = ? AND station_id = ?").get(id, stationId);
  if (!row) throw new CashAccountError("Hesap bulunamadi.", 404);
  return row;
}

export interface CreateAccountInput {
  name: string;
  kind: AccountKind;
}

export function createAccount(stationId: number, input: CreateAccountInput, actor: UserRow): CashAccountRow {
  const name = input.name.trim();
  if (name.length < 2) throw new CashAccountError("Hesap adi en az 2 karakter olmalidir.");
  try {
    const result = db
      .prepare("INSERT INTO cash_accounts (station_id, name, kind, created_by) VALUES (?, ?, ?, ?)")
      .run(stationId, name, input.kind, actor.id);
    return getAccount(stationId, result.lastInsertRowid as number);
  } catch {
    throw new CashAccountError("Bu isimde bir hesap zaten kayitli.", 409);
  }
}

export function updateAccount(stationId: number, id: number, input: { active: boolean }): CashAccountRow {
  getAccount(stationId, id);
  db.prepare("UPDATE cash_accounts SET active = ? WHERE id = ? AND station_id = ?").run(input.active ? 1 : 0, id, stationId);
  return getAccount(stationId, id);
}

export interface AccountWithBalance {
  id: number;
  name: string;
  kind: AccountKind;
  active: boolean;
  balance: number;
}

export function listAccountsWithBalance(stationId: number): AccountWithBalance[] {
  const rows = db
    .prepare<[number], { id: number; name: string; kind: AccountKind; active: number; balance: number | null }>(
      `SELECT a.id, a.name, a.kind, a.active,
              COALESCE(SUM(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END), 0) AS balance
         FROM cash_accounts a
         LEFT JOIN cash_account_movements m ON m.account_id = a.id
        WHERE a.station_id = ?
        GROUP BY a.id
        ORDER BY a.active DESC, a.name`
    )
    .all(stationId);
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, active: !!r.active, balance: round2(r.balance ?? 0) }));
}

export function getMovement(stationId: number, id: number): CashAccountMovementRow {
  const row = db
    .prepare<[number, number], CashAccountMovementRow>("SELECT * FROM cash_account_movements WHERE id = ? AND station_id = ?")
    .get(id, stationId);
  if (!row) throw new CashAccountError("Hareket bulunamadi.", 404);
  return row;
}

export interface RecordMovementInput {
  accountId: number;
  direction: MovementDirection;
  amount: number;
  movementDate: string;
  description?: string;
}

export function recordMovement(stationId: number, input: RecordMovementInput, actor: UserRow): CashAccountMovementRow {
  if (!(input.amount > 0)) throw new CashAccountError("Tutar sifirdan buyuk olmalidir.");
  getAccount(stationId, input.accountId);

  const result = db
    .prepare(
      "INSERT INTO cash_account_movements (station_id, account_id, direction, amount, movement_date, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(stationId, input.accountId, input.direction, round2(input.amount), input.movementDate, input.description?.trim() || null, actor.id);
  return getMovement(stationId, result.lastInsertRowid as number);
}

export interface MovementListFilters {
  accountId?: number;
  direction?: MovementDirection;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedMovements {
  movements: CashAccountMovementRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function listMovementsPaged(stationId: number, filters: MovementListFilters): PagedMovements {
  const clauses = ["station_id = ?"];
  const params: (string | number)[] = [stationId];
  if (filters.accountId) {
    clauses.push("account_id = ?");
    params.push(filters.accountId);
  }
  if (filters.direction) {
    clauses.push("direction = ?");
    params.push(filters.direction);
  }
  if (filters.from) {
    clauses.push("movement_date >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("movement_date <= ?");
    params.push(filters.to);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const total = (
    db.prepare<(string | number)[], { count: number }>(`SELECT COUNT(*) AS count FROM cash_account_movements ${where}`).get(...params) ?? {
      count: 0,
    }
  ).count;

  const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 200);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const movements = db
    .prepare<(string | number)[], CashAccountMovementRow>(
      `SELECT * FROM cash_account_movements ${where} ORDER BY movement_date DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  return { movements, total, page, pageSize };
}

export function deleteMovement(stationId: number, id: number): void {
  getMovement(stationId, id);
  db.prepare("DELETE FROM cash_account_movements WHERE id = ? AND station_id = ?").run(id, stationId);
}

export function serializeAccount(a: CashAccountRow) {
  return { id: a.id, name: a.name, kind: a.kind, active: !!a.active };
}

export function serializeMovement(m: CashAccountMovementRow) {
  return {
    id: m.id,
    accountId: m.account_id,
    direction: m.direction,
    amount: m.amount,
    movementDate: m.movement_date,
    description: m.description,
    createdAt: m.created_at,
  };
}
