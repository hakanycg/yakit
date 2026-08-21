import { describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestPump, createTestStation } from "../test/dbFixture.js";
import { KvkkError, eraseByPlate, lookupPersonalData } from "./kvkkService.js";

function insertTransaction(stationId: number, pumpId: number, plate: string, opts: Partial<{ totalAmount: number; dispensedLiters: number; receiptEmail: string; receiptPhone: string; status: string }> = {}): number {
  const result = db
    .prepare(
      `INSERT INTO transactions (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters, total_amount, payment_method, payment_status, status, receipt_email, receipt_phone, kiosk_access_token, started_at, completed_at)
       VALUES (?, ?, ?, 'benzin', 'amount', 44.5, ?, ?, 'card', 'paid', ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(
      stationId,
      pumpId,
      plate,
      opts.dispensedLiters ?? 10,
      opts.totalAmount ?? 445,
      opts.status ?? "completed",
      opts.receiptEmail ?? null,
      opts.receiptPhone ?? null,
      `kvkk-test-${stationId}-${pumpId}-${Date.now()}-${Math.random()}`
    );
  return result.lastInsertRowid as number;
}

function insertLoyalty(stationId: number, plate: string, points: number): void {
  db.prepare("INSERT INTO loyalty_accounts (station_id, plate, points) VALUES (?, ?, ?)").run(stationId, plate, points);
  db.prepare(
    "INSERT INTO loyalty_movements (station_id, plate, type, points, balance_after) VALUES (?, ?, 'earn', ?, ?)"
  ).run(stationId, plate, points, points);
}

describe("kvkkService - erisim", () => {
  it("bir plakaya ait islem ve sadakat verilerini toplar", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    insertTransaction(station.id, pumpId, "34ABC123", { totalAmount: 500, receiptEmail: "musteri@example.com" });
    insertLoyalty(station.id, "34ABC123", 25);

    const report = lookupPersonalData(station.id, "34abc123");
    expect(report.plate).toBe("34ABC123");
    expect(report.transactions).toHaveLength(1);
    expect(report.transactions[0]!.totalAmount).toBe(500);
    expect(report.transactions[0]!.receiptEmail).toBe("musteri@example.com");
    expect(report.loyalty?.points).toBe(25);
    expect(report.fleetLinked).toBe(false);
  });

  it("bos plaka icin hata firlatir", () => {
    const station = createTestStation();
    expect(() => lookupPersonalData(station.id, "   ")).toThrow(KvkkError);
  });
});

describe("kvkkService - unutulma hakki (anonimlestirme)", () => {
  it("islemlerdeki plaka/e-posta/telefonu anonimlestirir, sadakat hesabini siler", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    insertTransaction(station.id, pumpId, "06XYZ99", { receiptEmail: "a@b.com", receiptPhone: "5551234567" });
    insertTransaction(station.id, pumpId, "06XYZ99", {});
    insertLoyalty(station.id, "06XYZ99", 10);

    const result = eraseByPlate(station.id, "06xyz99");
    expect(result.transactionsAnonymized).toBe(2);
    expect(result.loyaltyAccountDeleted).toBe(true);
    expect(result.loyaltyMovementsAnonymized).toBe(1);

    const remaining = lookupPersonalData(station.id, "06xyz99");
    expect(remaining.transactions).toHaveLength(0);
    expect(remaining.loyalty).toBeNull();

    const anonRows = db.prepare("SELECT receipt_email, receipt_phone FROM transactions WHERE plate = '[SILINDI]' AND station_id = ?").all(station.id) as Array<{ receipt_email: string | null; receipt_phone: string | null }>;
    expect(anonRows.length).toBeGreaterThanOrEqual(2);
    expect(anonRows.every((r) => r.receipt_email === null && r.receipt_phone === null)).toBe(true);
  });

  it("filoya bagli bir plakayi anonimlestirmeyi reddeder", () => {
    const station = createTestStation();
    const account = db
      .prepare("INSERT INTO fleet_accounts (station_id, company_name) VALUES (?, 'Test Filo')")
      .run(station.id).lastInsertRowid as number;
    db.prepare("INSERT INTO fleet_plates (fleet_account_id, plate) VALUES (?, '34FLEET1')").run(account);

    expect(() => eraseByPlate(station.id, "34fleet1")).toThrow(KvkkError);
  });

  it("zaten anonimlestirilmis plakayi tekrar silmeyi reddeder", () => {
    const station = createTestStation();
    expect(() => eraseByPlate(station.id, "[silindi]")).toThrow(KvkkError);
  });
});
