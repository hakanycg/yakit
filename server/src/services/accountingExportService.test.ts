import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow } from "../db/types.js";
import { createTestPump, createTestStation } from "../test/dbFixture.js";
import { buildAccountingExport } from "./accountingExportService.js";

let station: StationRow;

function addSale(opts: {
  completedAt: string;
  amount: number;
  discount?: number;
  points?: number;
  method?: string;
}): number {
  const pumpId = createTestPump(station.id);
  return db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
          total_amount, discount_amount, loyalty_points_redeemed, payment_method, payment_status,
          status, kiosk_access_token, created_at, completed_at)
       VALUES (?, ?, '34ABC01', 'motorin', 'amount', 45, 10, ?, ?, ?, ?, 'captured', 'completed', ?, ?, ?)`
    )
    .run(
      station.id,
      pumpId,
      opts.amount,
      opts.discount ?? 0,
      opts.points ?? 0,
      opts.method ?? "iyzico",
      `tok-${Math.random().toString(16).slice(2)}`,
      opts.completedAt,
      opts.completedAt
    ).lastInsertRowid as number;
}

function addRefund(transactionId: number, amount: number, createdAt: string): void {
  db.prepare(
    `INSERT INTO refunds (station_id, transaction_id, amount, reason, payment_method, status, created_at)
     VALUES (?, ?, ?, 'Test iade', 'iyzico', 'completed', ?)`
  ).run(station.id, transactionId, amount, createdAt);
}

beforeEach(() => {
  station = createTestStation();
});

describe("buildAccountingExport", () => {
  it("iş günü bazında brüt/net/KDV/ödeme yöntemi kırılımını elle hesaplanmış değerlerle eşleştirir", () => {
    // Gün 1 (2026-08-18): iki satış, farklı ödeme yöntemleri.
    const saleA = addSale({ completedAt: "2026-08-18T09:00:00.000Z", amount: 1000, discount: 100, points: 50, method: "iyzico" });
    addSale({ completedAt: "2026-08-18T10:00:00.000Z", amount: 500, method: "pos" });
    // Gün 2 (2026-08-19): bir satış + gün 1'deki satışın gün 2'de KESİLEN bir iadesi.
    addSale({ completedAt: "2026-08-19T09:00:00.000Z", amount: 200, discount: 20, points: 10, method: "fleet" });
    addRefund(saleA, 100, "2026-08-19T11:00:00.000Z");

    const report = buildAccountingExport(station.id, "2026-08-18", "2026-08-19");

    expect(report.paymentMethods).toEqual(["fleet", "iyzico", "pos"]);
    expect(report.rows).toHaveLength(2);

    const day1 = report.rows.find((r) => r.businessDate === "2026-08-18")!;
    expect(day1.transactionCount).toBe(2);
    expect(day1.grossRevenue).toBe(1500);
    expect(day1.discountAmount).toBe(100);
    expect(day1.loyaltyPointsRedeemed).toBe(50);
    // net = (1000-100) + (500-0) = 1400; KDV %20 dahil netten geriye hesaplanır.
    expect(day1.netRevenue).toBe(1400);
    expect(day1.netRevenueExVat).toBe(1166.67);
    expect(day1.vatAmount).toBe(233.33);
    // İade GÜN 1'in satışına ait olsa da KESİLDİĞİ gün 2'ye yazılır - gün 1'de görünmez.
    expect(day1.refundCount).toBe(0);
    expect(day1.refundAmount).toBe(0);
    expect(day1.byPaymentMethod).toEqual({ iyzico: 900, pos: 500 });

    const day2 = report.rows.find((r) => r.businessDate === "2026-08-19")!;
    expect(day2.transactionCount).toBe(1);
    expect(day2.grossRevenue).toBe(200);
    expect(day2.discountAmount).toBe(20);
    expect(day2.loyaltyPointsRedeemed).toBe(10);
    expect(day2.netRevenue).toBe(180);
    expect(day2.netRevenueExVat).toBe(150);
    expect(day2.vatAmount).toBe(30);
    expect(day2.refundCount).toBe(1);
    expect(day2.refundAmount).toBe(100);
    expect(day2.byPaymentMethod).toEqual({ fleet: 180 });

    expect(report.totals).toEqual({
      transactionCount: 3,
      grossRevenue: 1700,
      discountAmount: 120,
      loyaltyPointsRedeemed: 60,
      netRevenue: 1580,
      vatAmount: 263.33,
      netRevenueExVat: 1316.67,
      refundCount: 1,
      refundAmount: 100,
    });
  });

  it("aralıkta hiç işlem/iade yoksa boş satır listesi ve sıfır toplam döner", () => {
    const report = buildAccountingExport(station.id, "2026-01-01", "2026-01-02");

    expect(report.rows).toEqual([]);
    expect(report.paymentMethods).toEqual([]);
    expect(report.totals).toEqual({
      transactionCount: 0,
      grossRevenue: 0,
      discountAmount: 0,
      loyaltyPointsRedeemed: 0,
      netRevenue: 0,
      vatAmount: 0,
      netRevenueExVat: 0,
      refundCount: 0,
      refundAmount: 0,
    });
  });

  it("baska istasyonun islemlerini karistirmaz", () => {
    const other = createTestStation();
    addSale({ completedAt: "2026-08-18T09:00:00.000Z", amount: 1000 });

    const report = buildAccountingExport(other.id, "2026-08-18", "2026-08-18");

    expect(report.rows).toEqual([]);
  });
});
