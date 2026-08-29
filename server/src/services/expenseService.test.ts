import { beforeEach, describe, expect, it } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { ExpenseError, createExpense, deleteExpense, listExpensesPaged, summarizeExpenses } from "./expenseService.js";

let station: StationRow;
let actor: UserRow;

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
});

describe("createExpense", () => {
  it("sifir veya negatif tutar reddedilir", () => {
    expect(() => createExpense(station.id, { category: "elektrik", amount: 0, expenseDate: "2026-01-10" }, actor)).toThrow(ExpenseError);
    expect(() => createExpense(station.id, { category: "elektrik", amount: -50, expenseDate: "2026-01-10" }, actor)).toThrow(ExpenseError);
  });

  it("gecerli gider kaydedilir ve tutar iki ondalige yuvarlanir", () => {
    const expense = createExpense(station.id, { category: "kira", amount: 1234.567, expenseDate: "2026-01-10", description: "Ocak kirasi" }, actor);
    expect(expense.amount).toBe(1234.57);
    expect(expense.category).toBe("kira");
    expect(expense.description).toBe("Ocak kirasi");
  });
});

describe("listExpensesPaged", () => {
  it("baska istasyonun giderlerini gostermez", () => {
    const other = createTestStation();
    createExpense(station.id, { category: "elektrik", amount: 100, expenseDate: "2026-01-05" }, actor);
    createExpense(other.id, { category: "elektrik", amount: 200, expenseDate: "2026-01-05" }, createTestUser(other.id, "admin"));

    const result = listExpensesPaged(station.id, {});
    expect(result.total).toBe(1);
    expect(result.expenses[0]!.amount).toBe(100);
  });

  it("kategori filtresi calisir", () => {
    createExpense(station.id, { category: "elektrik", amount: 100, expenseDate: "2026-01-05" }, actor);
    createExpense(station.id, { category: "kira", amount: 5000, expenseDate: "2026-01-05" }, actor);

    const result = listExpensesPaged(station.id, { category: "kira" });
    expect(result.total).toBe(1);
    expect(result.expenses[0]!.category).toBe("kira");
  });

  it("tarih araligi filtresi calisir", () => {
    createExpense(station.id, { category: "elektrik", amount: 100, expenseDate: "2026-01-01" }, actor);
    createExpense(station.id, { category: "elektrik", amount: 150, expenseDate: "2026-02-15" }, actor);

    const result = listExpensesPaged(station.id, { from: "2026-02-01", to: "2026-02-28" });
    expect(result.total).toBe(1);
    expect(result.expenses[0]!.amount).toBe(150);
  });

  it("total TUM eslesenleri yansitir, sadece o sayfayi degil", () => {
    for (let i = 0; i < 5; i++) createExpense(station.id, { category: "diger", amount: 10 + i, expenseDate: "2026-01-05" }, actor);

    const page1 = listExpensesPaged(station.id, { page: 1, pageSize: 2 });
    expect(page1.expenses).toHaveLength(2);
    expect(page1.total).toBe(5);
  });

  it("pageSize ve page sinirlarini asamaz", () => {
    createExpense(station.id, { category: "diger", amount: 10, expenseDate: "2026-01-05" }, actor);

    const result = listExpensesPaged(station.id, { page: -3, pageSize: 5000 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(200);
  });
});

describe("deleteExpense", () => {
  it("gideri siler", () => {
    const expense = createExpense(station.id, { category: "elektrik", amount: 100, expenseDate: "2026-01-05" }, actor);
    deleteExpense(station.id, expense.id);
    expect(listExpensesPaged(station.id, {}).total).toBe(0);
  });

  it("baska istasyonun giderini silemez", () => {
    const other = createTestStation();
    const expense = createExpense(other.id, { category: "elektrik", amount: 100, expenseDate: "2026-01-05" }, createTestUser(other.id, "admin"));
    expect(() => deleteExpense(station.id, expense.id)).toThrow(ExpenseError);
  });
});

describe("summarizeExpenses", () => {
  it("kategori bazinda dogru toplar", () => {
    createExpense(station.id, { category: "elektrik", amount: 100, expenseDate: "2026-01-05" }, actor);
    createExpense(station.id, { category: "elektrik", amount: 50, expenseDate: "2026-01-10" }, actor);
    createExpense(station.id, { category: "kira", amount: 5000, expenseDate: "2026-01-01" }, actor);

    const summary = summarizeExpenses(station.id);
    expect(summary.total).toBe(5150);
    const elektrik = summary.byCategory.find((c) => c.category === "elektrik");
    expect(elektrik?.total).toBe(150);
  });

  it("tarih araligina gore filtreler", () => {
    createExpense(station.id, { category: "elektrik", amount: 100, expenseDate: "2026-01-05" }, actor);
    createExpense(station.id, { category: "elektrik", amount: 999, expenseDate: "2026-03-01" }, actor);

    const summary = summarizeExpenses(station.id, "2026-01-01", "2026-01-31");
    expect(summary.total).toBe(100);
  });
});
