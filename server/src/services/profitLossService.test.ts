import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import type { StationRow, UserRow } from "../db/types.js";
import { addStock } from "./fuelStockService.js";
import { createExpense } from "./expenseService.js";
import { getProfitLossSummary } from "./profitLossService.js";

function insertTransaction(
  stationId: number,
  pumpId: number,
  opts: { status?: string; totalAmount: number; discountAmount?: number; createdAt?: string }
): number {
  const result = db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, total_amount, discount_amount, status, kiosk_access_token, created_at)
       VALUES (?, ?, 'TEST0001', 'benzin', 'amount', 44.5, ?, ?, ?, ?, ?)`
    )
    .run(
      stationId,
      pumpId,
      opts.totalAmount,
      opts.discountAmount ?? 0,
      opts.status ?? "completed",
      `test-token-${stationId}-${pumpId}-${Date.now()}-${Math.random()}`,
      opts.createdAt ?? new Date().toISOString()
    );
  return result.lastInsertRowid as number;
}

describe("getProfitLossSummary", () => {
  let station: StationRow;
  let actor: UserRow;
  let pumpId: number;

  beforeEach(() => {
    station = createTestStation();
    actor = createTestUser(station.id, "admin");
    pumpId = createTestPump(station.id);
  });

  it("gider/maliyet yokken brut kar ve net kar gelire esittir", () => {
    insertTransaction(station.id, pumpId, { totalAmount: 1000 });
    const summary = getProfitLossSummary(station.id);
    expect(summary.revenue).toBe(1000);
    expect(summary.cogs).toBe(0);
    expect(summary.grossProfit).toBe(1000);
    expect(summary.expenses).toBe(0);
    expect(summary.netProfit).toBe(1000);
    expect(summary.grossMarginPct).toBe(100);
    expect(summary.netMarginPct).toBe(100);
  });

  it("tamamlanmamis islemler gelire dahil edilmez", () => {
    insertTransaction(station.id, pumpId, { totalAmount: 1000, status: "completed" });
    insertTransaction(station.id, pumpId, { totalAmount: 500, status: "cancelled" });
    insertTransaction(station.id, pumpId, { totalAmount: 500, status: "failed" });

    const summary = getProfitLossSummary(station.id);
    expect(summary.revenue).toBe(1000);
  });

  it("indirimli islemde gelir net (chargeAmount) yansir, indirim ayri raporlanir", () => {
    insertTransaction(station.id, pumpId, { totalAmount: 1000, discountAmount: 100 });
    const summary = getProfitLossSummary(station.id);
    expect(summary.revenue).toBe(900);
    expect(summary.discount).toBe(100);
  });

  it("maliyetlendirilmis ve maliyetlendirilmemis teslimat karisik: yalnizca maliyetlendirilmis kisim COGS'a girer", () => {
    addStock(station.id, "benzin", 1000, { supplier: "Tedarikci A", unitCost: 30 }, actor);
    addStock(station.id, "benzin", 500, { supplier: "Tedarikci B" }, actor); // unitCost yok
    insertTransaction(station.id, pumpId, { totalAmount: 100000 });

    const summary = getProfitLossSummary(station.id);
    expect(summary.cogs).toBe(30000); // yalnizca 1000 * 30
  });

  it("birden fazla gider kategorisi toplanir", () => {
    createExpense(station.id, { category: "elektrik", description: "Fatura", amount: 200, expenseDate: "2026-01-05" }, actor);
    createExpense(station.id, { category: "kira", description: "Kira", amount: 300, expenseDate: "2026-01-10" }, actor);
    insertTransaction(station.id, pumpId, { totalAmount: 1000 });

    const summary = getProfitLossSummary(station.id);
    expect(summary.expenses).toBe(500);
    expect(summary.netProfit).toBe(500);
  });

  it("tam senaryo: revenue - cogs - expenses = netProfit, marjlar dogru hesaplanir", () => {
    insertTransaction(station.id, pumpId, { totalAmount: 10000 });
    addStock(station.id, "benzin", 100, { supplier: "Tedarikci A", unitCost: 40 }, actor); // cogs 4000
    createExpense(station.id, { category: "personel_maasi", description: "Maas", amount: 2000, expenseDate: "2026-01-05" }, actor);

    const summary = getProfitLossSummary(station.id);
    expect(summary.revenue).toBe(10000);
    expect(summary.cogs).toBe(4000);
    expect(summary.grossProfit).toBe(6000);
    expect(summary.expenses).toBe(2000);
    expect(summary.netProfit).toBe(4000);
    expect(summary.grossMarginPct).toBe(60);
    expect(summary.netMarginPct).toBe(40);
  });

  it("tarih araligi filtresi hem islemleri hem teslimatlari kapsar", () => {
    insertTransaction(station.id, pumpId, { totalAmount: 1000, createdAt: "2026-01-05T10:00:00.000Z" });
    insertTransaction(station.id, pumpId, { totalAmount: 2000, createdAt: "2026-03-05T10:00:00.000Z" });
    addStock(station.id, "benzin", 100, { supplier: "Tedarikci A", unitCost: 10 }, actor);
    db.prepare("UPDATE fuel_stock_movements SET created_at = ? WHERE station_id = ?").run("2026-01-06T10:00:00.000Z", station.id);

    const janOnly = getProfitLossSummary(station.id, "2026-01-01", "2026-01-31");
    expect(janOnly.revenue).toBe(1000);
    expect(janOnly.cogs).toBe(1000);

    const marOnly = getProfitLossSummary(station.id, "2026-03-01", "2026-03-31");
    expect(marOnly.revenue).toBe(2000);
    expect(marOnly.cogs).toBe(0);
  });

  it("baska istasyonun verisi karismaz", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    const otherPump = createTestPump(other.id);
    insertTransaction(other.id, otherPump, { totalAmount: 5000 });
    addStock(other.id, "benzin", 100, { supplier: "X", unitCost: 10 }, otherActor);
    createExpense(other.id, { category: "diger", description: "X", amount: 100, expenseDate: "2026-01-01" }, otherActor);

    const summary = getProfitLossSummary(station.id);
    expect(summary.revenue).toBe(0);
    expect(summary.cogs).toBe(0);
    expect(summary.expenses).toBe(0);
  });

  it("sifir gelirde marj yuzdeleri null doner", () => {
    const summary = getProfitLossSummary(station.id);
    expect(summary.revenue).toBe(0);
    expect(summary.grossMarginPct).toBeNull();
    expect(summary.netMarginPct).toBeNull();
  });
});
