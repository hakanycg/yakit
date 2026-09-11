import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import type { StationRow, UserRow } from "../db/types.js";
import { getOperatorAnomalyReport } from "./operatorAnomalyService.js";

let station: StationRow;
let pumpId: number;

function insertTransaction(
  operatorUserId: number,
  opts: { status?: string; discountAmount?: number }
): void {
  db.prepare(
    `INSERT INTO transactions
       (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, total_amount, discount_amount, dispensed_liters, status, operator_user_id, kiosk_access_token, created_at)
     VALUES (?, ?, '34ABC01', 'benzin', 'amount', 44.5, 100, ?, 10, ?, ?, ?, ?)`
  ).run(
    station.id,
    pumpId,
    opts.discountAmount ?? 0,
    opts.status ?? "completed",
    operatorUserId,
    `tok-${operatorUserId}-${Math.random()}`,
    new Date().toISOString()
  );
}

beforeEach(() => {
  station = createTestStation();
  pumpId = createTestPump(station.id);
});

describe("getOperatorAnomalyReport", () => {
  it("her personelin toplam/iptal/indirim sayisini ayri ayri hesaplar", () => {
    const op1 = createTestUser(station.id, "operator");
    for (let i = 0; i < 10; i++) insertTransaction(op1.id, {});
    insertTransaction(op1.id, { status: "cancelled" });
    insertTransaction(op1.id, { discountAmount: 10 });

    const rows = getOperatorAnomalyReport(station.id);
    const row = rows.find((r) => r.userId === op1.id)!;
    expect(row.totalCount).toBe(12);
    expect(row.cancelledCount).toBe(1);
    expect(row.discountedCount).toBe(1);
  });

  it("istasyon ortalamasinin BELIRGIN uzerinde iptal orani olan personeli anomali olarak isaretler", () => {
    const normalOp = createTestUser(station.id, "operator");
    for (let i = 0; i < 20; i++) insertTransaction(normalOp.id, {});
    insertTransaction(normalOp.id, { status: "cancelled" }); // ~%4.5 iptal

    const suspiciousOp = createTestUser(station.id, "operator");
    for (let i = 0; i < 10; i++) insertTransaction(suspiciousOp.id, {});
    for (let i = 0; i < 10; i++) insertTransaction(suspiciousOp.id, { status: "cancelled" }); // %50 iptal

    const rows = getOperatorAnomalyReport(station.id);
    const normal = rows.find((r) => r.userId === normalOp.id)!;
    const suspicious = rows.find((r) => r.userId === suspiciousOp.id)!;

    expect(suspicious.isCancelRateAnomaly).toBe(true);
    expect(normal.isCancelRateAnomaly).toBe(false);
  });

  it("asgari islem sayisinin ALTINDAKI personeli oran yuksek olsa bile anomali ISARETLEMEZ", () => {
    const normalOp = createTestUser(station.id, "operator");
    for (let i = 0; i < 20; i++) insertTransaction(normalOp.id, {});

    const tinyOp = createTestUser(station.id, "operator");
    insertTransaction(tinyOp.id, { status: "cancelled" });
    insertTransaction(tinyOp.id, {});

    const rows = getOperatorAnomalyReport(station.id);
    const tiny = rows.find((r) => r.userId === tinyOp.id)!;
    expect(tiny.cancelRatePct).toBe(50);
    expect(tiny.isCancelRateAnomaly).toBe(false);
  });

  it("istasyon ortalamasinin BELIRGIN uzerinde indirim orani olan personeli anomali olarak isaretler", () => {
    const normalOp = createTestUser(station.id, "operator");
    for (let i = 0; i < 20; i++) insertTransaction(normalOp.id, {});
    insertTransaction(normalOp.id, { discountAmount: 5 });

    const heavyDiscountOp = createTestUser(station.id, "operator");
    for (let i = 0; i < 15; i++) insertTransaction(heavyDiscountOp.id, { discountAmount: 5 });

    const rows = getOperatorAnomalyReport(station.id);
    const heavy = rows.find((r) => r.userId === heavyDiscountOp.id)!;
    expect(heavy.isDiscountRateAnomaly).toBe(true);
  });

  it("baska bir istasyonun personelini karistirmaz", () => {
    const otherStation = createTestStation();
    const otherPump = createTestPump(otherStation.id);
    const otherOp = createTestUser(otherStation.id, "operator");
    db.prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, total_amount, discount_amount, dispensed_liters, status, operator_user_id, kiosk_access_token, created_at)
       VALUES (?, ?, '34OTHER1', 'benzin', 'amount', 44.5, 100, 0, 10, 'completed', ?, 'tok-other', ?)`
    ).run(otherStation.id, otherPump, otherOp.id, new Date().toISOString());

    const rows = getOperatorAnomalyReport(station.id);
    expect(rows.find((r) => r.userId === otherOp.id)).toBeUndefined();
  });

  it("hic islemi olmayan istasyon icin bos liste doner", () => {
    expect(getOperatorAnomalyReport(station.id)).toEqual([]);
  });
});
