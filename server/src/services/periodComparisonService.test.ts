import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import type { StationRow, UserRow } from "../db/types.js";
import { getPeriodComparison } from "./periodComparisonService.js";

function insertTransaction(
  stationId: number,
  pumpId: number,
  opts: { status?: string; totalAmount: number; discountAmount?: number; liters?: number; createdAt: string }
): number {
  const result = db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, total_amount, discount_amount, dispensed_liters, status, kiosk_access_token, created_at)
       VALUES (?, ?, 'TEST0001', 'benzin', 'amount', 44.5, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      stationId,
      pumpId,
      opts.totalAmount,
      opts.discountAmount ?? 0,
      opts.liters ?? 10,
      opts.status ?? "completed",
      `test-token-${stationId}-${pumpId}-${Date.now()}-${Math.random()}`,
      opts.createdAt
    );
  return result.lastInsertRowid as number;
}

describe("getPeriodComparison", () => {
  let station: StationRow;
  let actor: UserRow;
  let pumpId: number;

  beforeEach(() => {
    station = createTestStation();
    actor = createTestUser(station.id, "admin");
    void actor;
    pumpId = createTestPump(station.id);
  });

  it("iki donemin ciro/litre/islem sayisini ayri ayri toplar", () => {
    // Onceki donem (Ocak): 2 islem, toplam 200 TL, 20 litre.
    insertTransaction(station.id, pumpId, { totalAmount: 100, liters: 10, createdAt: "2024-01-05T10:00:00.000Z" });
    insertTransaction(station.id, pumpId, { totalAmount: 100, liters: 10, createdAt: "2024-01-20T10:00:00.000Z" });
    // Guncel donem (Subat): 3 islem, toplam 300 TL, 30 litre - %50 artis.
    insertTransaction(station.id, pumpId, { totalAmount: 100, liters: 10, createdAt: "2024-02-05T10:00:00.000Z" });
    insertTransaction(station.id, pumpId, { totalAmount: 100, liters: 10, createdAt: "2024-02-15T10:00:00.000Z" });
    insertTransaction(station.id, pumpId, { totalAmount: 100, liters: 10, createdAt: "2024-02-25T10:00:00.000Z" });

    const result = getPeriodComparison(station.id, "2024-02-01", "2024-02-29", "2024-01-01", "2024-01-31");

    expect(result.current.revenue).toBe(300);
    expect(result.current.transactionCount).toBe(3);
    expect(result.current.liters).toBe(30);
    expect(result.previous.revenue).toBe(200);
    expect(result.previous.transactionCount).toBe(2);
    expect(result.previous.liters).toBe(20);
    expect(result.changePct.revenue).toBe(50);
    expect(result.changePct.transactionCount).toBe(50);
    expect(result.changePct.liters).toBe(50);
  });

  it("sadece tamamlanmis (completed) islemleri sayar", () => {
    insertTransaction(station.id, pumpId, { totalAmount: 100, status: "completed", createdAt: "2024-02-05T10:00:00.000Z" });
    insertTransaction(station.id, pumpId, { totalAmount: 999, status: "cancelled", createdAt: "2024-02-06T10:00:00.000Z" });

    const result = getPeriodComparison(station.id, "2024-02-01", "2024-02-29", "2024-01-01", "2024-01-31");
    expect(result.current.revenue).toBe(100);
    expect(result.current.transactionCount).toBe(1);
  });

  it("onceki donem sifirken ve guncel donem de sifirsa yuzde degisim 0'dir", () => {
    const result = getPeriodComparison(station.id, "2024-02-01", "2024-02-29", "2024-01-01", "2024-01-31");
    expect(result.changePct.revenue).toBe(0);
  });

  it("onceki donem sifir ama guncel donemde satis varsa yuzde degisim tanimsizdir (null)", () => {
    insertTransaction(station.id, pumpId, { totalAmount: 100, createdAt: "2024-02-05T10:00:00.000Z" });
    const result = getPeriodComparison(station.id, "2024-02-01", "2024-02-29", "2024-01-01", "2024-01-31");
    expect(result.changePct.revenue).toBeNull();
  });

  it("baska bir istasyonun islemlerini karistirmaz", () => {
    const otherStation = createTestStation();
    const otherPump = createTestPump(otherStation.id);
    insertTransaction(otherStation.id, otherPump, { totalAmount: 5000, createdAt: "2024-02-05T10:00:00.000Z" });
    insertTransaction(station.id, pumpId, { totalAmount: 100, createdAt: "2024-02-05T10:00:00.000Z" });

    const result = getPeriodComparison(station.id, "2024-02-01", "2024-02-29", "2024-01-01", "2024-01-31");
    expect(result.current.revenue).toBe(100);
  });
});
