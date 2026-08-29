import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import type { StationRow, UserRow } from "../db/types.js";
import { addStock } from "./fuelStockService.js";
import { createExpense } from "./expenseService.js";
import { getVatSummary } from "./vatService.js";

function insertTransaction(stationId: number, pumpId: number, totalAmount: number): number {
  const result = db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, total_amount, discount_amount, status, kiosk_access_token)
       VALUES (?, ?, 'TEST0001', 'benzin', 'amount', 44.5, ?, 0, 'completed', ?)`
    )
    .run(stationId, pumpId, totalAmount, `test-token-${stationId}-${pumpId}-${Date.now()}-${Math.random()}`);
  return result.lastInsertRowid as number;
}

describe("getVatSummary", () => {
  let station: StationRow;
  let actor: UserRow;
  let pumpId: number;

  beforeEach(() => {
    station = createTestStation();
    actor = createTestUser(station.id, "admin");
    pumpId = createTestPump(station.id);
  });

  it("bilinen bir gelir icin hesaplanan KDV dogru hesaplanir", () => {
    insertTransaction(station.id, pumpId, 1200);
    const summary = getVatSummary(station.id);
    expect(summary.outputVatBase).toBe(1200);
    expect(summary.outputVat).toBe(200); // 1200 - 1200/1.2 = 200
  });

  it("bilinen cogs+expenses toplami icin indirilecek KDV dogru hesaplanir", () => {
    addStock(station.id, "benzin", 100, { supplier: "Tedarikci A", unitCost: 6 }, actor); // cogs 600
    createExpense(station.id, { category: "kira", description: "Kira", amount: 600, expenseDate: "2026-01-05" }, actor); // expenses 600
    const summary = getVatSummary(station.id);
    expect(summary.inputVatBase).toBe(1200);
    expect(summary.inputVat).toBe(200);
  });

  it("net KDV = hesaplanan - indirilecek, isaret dogru", () => {
    insertTransaction(station.id, pumpId, 2400); // outputVat = 400
    addStock(station.id, "benzin", 100, { supplier: "Tedarikci A", unitCost: 6 }, actor); // cogs 600
    createExpense(station.id, { category: "kira", description: "Kira", amount: 600, expenseDate: "2026-01-05" }, actor); // expenses 600 -> inputVatBase 1200, inputVat 200

    const summary = getVatSummary(station.id);
    expect(summary.outputVat).toBe(400);
    expect(summary.inputVat).toBe(200);
    expect(summary.netVat).toBe(200); // odenecek KDV (pozitif)
  });

  it("indirilecek hesaplanandan buyukse net KDV negatif (devreden) olur", () => {
    insertTransaction(station.id, pumpId, 600); // outputVat = 100
    addStock(station.id, "benzin", 100, { supplier: "Tedarikci A", unitCost: 12 }, actor); // cogs 1200 -> inputVat 200

    const summary = getVatSummary(station.id);
    expect(summary.outputVat).toBe(100);
    expect(summary.inputVat).toBe(200);
    expect(summary.netVat).toBe(-100); // devreden KDV
  });

  it("veri yokken tum KDV alanlari sifirdir", () => {
    const summary = getVatSummary(station.id);
    expect(summary.outputVat).toBe(0);
    expect(summary.inputVat).toBe(0);
    expect(summary.netVat).toBe(0);
  });

  it("istasyon ve tarih parametreleri getProfitLossSummary'ye dogru iletilir", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    const otherPump = createTestPump(other.id);
    insertTransaction(other.id, otherPump, 1200);
    void otherActor;

    const summary = getVatSummary(station.id);
    expect(summary.outputVat).toBe(0);

    insertTransaction(station.id, pumpId, 1200);
    db.prepare("UPDATE transactions SET created_at = ? WHERE station_id = ?").run("2026-01-05T10:00:00.000Z", station.id);

    const janOnly = getVatSummary(station.id, "2026-01-01", "2026-01-31");
    expect(janOnly.outputVat).toBe(200);

    const febOnly = getVatSummary(station.id, "2026-02-01", "2026-02-28");
    expect(febOnly.outputVat).toBe(0);
  });
});
