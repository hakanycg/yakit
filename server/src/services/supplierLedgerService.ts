import { db } from "../db/index.js";
import type { SupplierPaymentRow, UserRow } from "../db/types.js";
import { FuelOrderError, getSupplier } from "./fuelOrderService.js";

/**
 * Tedarikci cari hesabi (borc takibi, on muhasebe 2. modul).
 *
 * Yalnizca SIPARIS uzerinden yapilan teslimatlar borca dahil edilir:
 * fuel_stock_movements.supplier serbest metin ve bilerek fuel_suppliers'a
 * baglanmiyor (bkz. schema.sql), bu yuzden guvenilir bir supplier_id eslesmesi
 * yalnizca fuel_orders uzerinden kurulabilir. Borc tutari, getSupplierSummary
 * (fuelStockService.ts) ile AYNI taban uzerinden (liters * unit_cost, fiilen
 * giren miktar - irsaliye farkı ayri bir ekranda izleniyor) hesaplanir.
 */

export class SupplierLedgerError extends Error {
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

export function getPayment(stationId: number, id: number): SupplierPaymentRow {
  const row = db
    .prepare<[number, number], SupplierPaymentRow>("SELECT * FROM supplier_payments WHERE id = ? AND station_id = ?")
    .get(id, stationId);
  if (!row) throw new SupplierLedgerError("Odeme bulunamadi.", 404);
  return row;
}

export interface RecordPaymentInput {
  supplierId: number;
  amount: number;
  paymentDate: string;
  note?: string;
}

/** Pasif bir tedarikciye de odeme yapilabilir - borc, tedarikci pasife alindiktan sonra da kapatilir. */
export function recordPayment(stationId: number, input: RecordPaymentInput, actor: UserRow): SupplierPaymentRow {
  if (!(input.amount > 0)) throw new SupplierLedgerError("Tutar sifirdan buyuk olmalidir.");
  try {
    getSupplier(stationId, input.supplierId);
  } catch (err) {
    if (err instanceof FuelOrderError) throw new SupplierLedgerError(err.message, err.status);
    throw err;
  }

  const result = db
    .prepare("INSERT INTO supplier_payments (station_id, supplier_id, amount, payment_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(stationId, input.supplierId, round2(input.amount), input.paymentDate, input.note?.trim() || null, actor.id);
  return getPayment(stationId, result.lastInsertRowid as number);
}

export interface PaymentListFilters {
  supplierId?: number;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedPayments {
  payments: SupplierPaymentRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function listPaymentsPaged(stationId: number, filters: PaymentListFilters): PagedPayments {
  const clauses = ["station_id = ?"];
  const params: (string | number)[] = [stationId];
  if (filters.supplierId) {
    clauses.push("supplier_id = ?");
    params.push(filters.supplierId);
  }
  if (filters.from) {
    clauses.push("payment_date >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("payment_date <= ?");
    params.push(filters.to);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const total = (
    db.prepare<(string | number)[], { count: number }>(`SELECT COUNT(*) AS count FROM supplier_payments ${where}`).get(...params) ?? {
      count: 0,
    }
  ).count;

  const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 200);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const payments = db
    .prepare<(string | number)[], SupplierPaymentRow>(
      `SELECT * FROM supplier_payments ${where} ORDER BY payment_date DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  return { payments, total, page, pageSize };
}

export function deletePayment(stationId: number, id: number): void {
  getPayment(stationId, id);
  db.prepare("DELETE FROM supplier_payments WHERE id = ? AND station_id = ?").run(id, stationId);
}

export interface SupplierLedgerEntry {
  supplierId: number;
  supplierName: string;
  totalOwed: number;
  totalPaid: number;
  balance: number;
  /** Birim maliyeti girilmemis, bu yuzden borca dahil edilemeyen teslimat sayisi. */
  uncostedDeliveries: number;
}

export function getSupplierLedger(stationId: number): SupplierLedgerEntry[] {
  const owedRows = db
    .prepare<
      [number],
      { supplier_id: number; supplier_name: string; totalOwed: number | null; uncostedDeliveries: number }
    >(
      `SELECT fo.supplier_id AS supplier_id, fo.supplier_name AS supplier_name,
              COALESCE(SUM(CASE WHEN fsm.unit_cost IS NOT NULL THEN fsm.liters * fsm.unit_cost ELSE 0 END), 0) AS totalOwed,
              SUM(CASE WHEN fsm.unit_cost IS NULL THEN 1 ELSE 0 END) AS uncostedDeliveries
         FROM fuel_orders fo
         JOIN fuel_stock_movements fsm ON fsm.id = fo.delivery_movement_id
        WHERE fo.station_id = ? AND fo.status = 'received' AND fo.supplier_id IS NOT NULL
        GROUP BY fo.supplier_id, fo.supplier_name`
    )
    .all(stationId);

  const paidRows = db
    .prepare<[number], { supplier_id: number; totalPaid: number }>(
      `SELECT supplier_id, COALESCE(SUM(amount), 0) AS totalPaid FROM supplier_payments WHERE station_id = ? GROUP BY supplier_id`
    )
    .all(stationId);
  const paidBySupplier = new Map(paidRows.map((r) => [r.supplier_id, r.totalPaid]));

  const entries = new Map<number, SupplierLedgerEntry>();
  for (const r of owedRows) {
    entries.set(r.supplier_id, {
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      totalOwed: round2(r.totalOwed ?? 0),
      totalPaid: 0,
      balance: 0,
      uncostedDeliveries: r.uncostedDeliveries,
    });
  }
  for (const [supplierId, totalPaid] of paidBySupplier) {
    const existing = entries.get(supplierId);
    if (existing) {
      existing.totalPaid = round2(totalPaid);
    } else {
      // Borcu olmayan ama gecmiste odeme yapilmis (ör. iade/avans) bir tedarikci -
      // yine de listede gorunmeli, negatif bakiye onu isaret eder.
      const supplier = db.prepare<[number, number], { name: string }>("SELECT name FROM fuel_suppliers WHERE id = ? AND station_id = ?").get(supplierId, stationId);
      entries.set(supplierId, {
        supplierId,
        supplierName: supplier?.name ?? "?",
        totalOwed: 0,
        totalPaid: round2(totalPaid),
        balance: 0,
        uncostedDeliveries: 0,
      });
    }
  }

  return Array.from(entries.values())
    .map((e) => ({ ...e, balance: round2(e.totalOwed - e.totalPaid) }))
    .sort((a, b) => b.balance - a.balance);
}

export function serializePayment(p: SupplierPaymentRow) {
  return {
    id: p.id,
    supplierId: p.supplier_id,
    amount: p.amount,
    paymentDate: p.payment_date,
    note: p.note,
    createdAt: p.created_at,
  };
}
