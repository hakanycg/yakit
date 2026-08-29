import { db } from "../db/index.js";
import type { ExpenseRow, UserRow } from "../db/types.js";

/**
 * Genel gider takibi (on muhasebe, 1. modul).
 *
 * fuel_orders zaten yakit ALIM maliyetini tutuyor; burada eksik olan istasyonun
 * yakit DISINDAKI isletme giderleridir (elektrik, kira, bakim, personel maasi vb.).
 * Ileride "Gelir-Gider ozeti" bu tabloyu yakit satis geliri ve yakit alim
 * maliyetiyle birlestirecek.
 */

export class ExpenseError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export const EXPENSE_CATEGORIES = [
  "elektrik",
  "su_dogalgaz",
  "kira",
  "bakim_onarim",
  "personel_maasi",
  "sigorta",
  "vergi_harc",
  "diger",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function getExpense(stationId: number, id: number): ExpenseRow {
  const row = db.prepare<[number, number], ExpenseRow>("SELECT * FROM expenses WHERE id = ? AND station_id = ?").get(id, stationId);
  if (!row) throw new ExpenseError("Gider bulunamadi.", 404);
  return row;
}

export interface CreateExpenseInput {
  category: ExpenseCategory;
  description?: string;
  amount: number;
  expenseDate: string;
}

export function createExpense(stationId: number, input: CreateExpenseInput, actor: UserRow): ExpenseRow {
  if (!(input.amount > 0)) throw new ExpenseError("Tutar sifirdan buyuk olmalidir.");

  const result = db
    .prepare("INSERT INTO expenses (station_id, category, description, amount, expense_date, created_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(stationId, input.category, input.description?.trim() || null, round2(input.amount), input.expenseDate, actor.id);
  return getExpense(stationId, result.lastInsertRowid as number);
}

export interface ExpenseListFilters {
  category?: ExpenseCategory;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedExpenses {
  expenses: ExpenseRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function listExpensesPaged(stationId: number, filters: ExpenseListFilters): PagedExpenses {
  const clauses = ["station_id = ?"];
  const params: (string | number)[] = [stationId];
  if (filters.category) {
    clauses.push("category = ?");
    params.push(filters.category);
  }
  if (filters.from) {
    clauses.push("expense_date >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("expense_date <= ?");
    params.push(filters.to);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const total = (
    db.prepare<(string | number)[], { count: number }>(`SELECT COUNT(*) AS count FROM expenses ${where}`).get(...params) ?? { count: 0 }
  ).count;

  const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 200);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const expenses = db
    .prepare<(string | number)[], ExpenseRow>(`SELECT * FROM expenses ${where} ORDER BY expense_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);

  return { expenses, total, page, pageSize };
}

export function deleteExpense(stationId: number, id: number): void {
  getExpense(stationId, id);
  db.prepare("DELETE FROM expenses WHERE id = ? AND station_id = ?").run(id, stationId);
}

export interface ExpenseSummary {
  byCategory: { category: ExpenseCategory; total: number }[];
  total: number;
}

export function summarizeExpenses(stationId: number, from?: string, to?: string): ExpenseSummary {
  const clauses = ["station_id = ?"];
  const params: (string | number)[] = [stationId];
  if (from) {
    clauses.push("expense_date >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("expense_date <= ?");
    params.push(to);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const rows = db
    .prepare<(string | number)[], { category: ExpenseCategory; total: number }>(
      `SELECT category, COALESCE(SUM(amount), 0) AS total FROM expenses ${where} GROUP BY category ORDER BY total DESC`
    )
    .all(...params);

  const total = round2(rows.reduce((sum, r) => sum + r.total, 0));
  return { byCategory: rows.map((r) => ({ category: r.category, total: round2(r.total) })), total };
}

export function serializeExpense(e: ExpenseRow) {
  return {
    id: e.id,
    category: e.category,
    description: e.description,
    amount: e.amount,
    expenseDate: e.expense_date,
    createdAt: e.created_at,
  };
}
