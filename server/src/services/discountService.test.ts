import { beforeEach, describe, expect, it } from "vitest";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { DiscountError, createCode, getUsageStats, redeemCode, releaseCode, validateCode } from "./discountService.js";

describe("discountService", () => {
  let station: StationRow;
  let actor: UserRow;

  beforeEach(() => {
    station = createTestStation();
    actor = createTestUser(station.id);
  });

  it("computes a percent discount", () => {
    createCode(station.id, { code: "YAZ10", type: "percent", value: 10 }, actor);
    const { discountAmount } = validateCode(station.id, "YAZ10", "benzin", 500);
    expect(discountAmount).toBe(50);
  });

  it("computes a fixed discount", () => {
    createCode(station.id, { code: "SABIT50", type: "fixed", value: 50 }, actor);
    const { discountAmount } = validateCode(station.id, "SABIT50", "benzin", 500);
    expect(discountAmount).toBe(50);
  });

  it("clamps the discount so it never exceeds the total amount", () => {
    createCode(station.id, { code: "BUYUKINDIRIM", type: "fixed", value: 500 }, actor);
    const { discountAmount } = validateCode(station.id, "BUYUKINDIRIM", "benzin", 100);
    expect(discountAmount).toBe(100);
  });

  it("is case-insensitive and trims whitespace", () => {
    createCode(station.id, { code: "yaz10", type: "percent", value: 10 }, actor);
    expect(() => validateCode(station.id, "  YAZ10  ", "benzin", 500)).not.toThrow();
  });

  it("rejects an unknown code", () => {
    expect(() => validateCode(station.id, "YOK", "benzin", 500)).toThrow(DiscountError);
  });

  it("rejects a code restricted to a different fuel type", () => {
    createCode(station.id, { code: "SADECEMOTORIN", type: "percent", value: 10, fuelType: "motorin" }, actor);
    expect(() => validateCode(station.id, "SADECEMOTORIN", "benzin", 500)).toThrow(DiscountError);
    expect(() => validateCode(station.id, "SADECEMOTORIN", "motorin", 500)).not.toThrow();
  });

  it("rejects a code that has not started yet", () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    createCode(station.id, { code: "GELECEK", type: "percent", value: 10, startsAt: future }, actor);
    expect(() => validateCode(station.id, "GELECEK", "benzin", 500)).toThrow(DiscountError);
  });

  it("rejects an expired code", () => {
    const past = new Date(Date.now() - 86400_000).toISOString();
    createCode(station.id, { code: "GECMIS", type: "percent", value: 10, expiresAt: past }, actor);
    expect(() => validateCode(station.id, "GECMIS", "benzin", 500)).toThrow(DiscountError);
  });

  it("rejects a code once its max uses is reached", () => {
    createCode(station.id, { code: "SINIRLI", type: "percent", value: 10, maxUses: 1 }, actor);
    redeemCode(station.id, "SINIRLI");
    expect(() => validateCode(station.id, "SINIRLI", "benzin", 500)).toThrow(DiscountError);
  });

  it("releaseCode reverts a redemption so the code can be reused, floored at zero", () => {
    createCode(station.id, { code: "IPTAL", type: "percent", value: 10, maxUses: 1 }, actor);
    redeemCode(station.id, "IPTAL");
    releaseCode(station.id, "IPTAL");
    expect(() => validateCode(station.id, "IPTAL", "benzin", 500)).not.toThrow();

    // releasing again (no matching redemption) must not go negative / throw
    releaseCode(station.id, "IPTAL");
    const row = db.prepare("SELECT used_count FROM discount_codes WHERE station_id = ? AND code = ?").get(station.id, "IPTAL") as {
      used_count: number;
    };
    expect(row.used_count).toBe(0);
  });

  it("prevents creating a duplicate code for the same station", () => {
    createCode(station.id, { code: "AYNI", type: "percent", value: 10 }, actor);
    expect(() => createCode(station.id, { code: "AYNI", type: "fixed", value: 5 }, actor)).toThrow(DiscountError);
  });

  it("getUsageStats reflects only completed transactions, not the live used_count", () => {
    const code = createCode(station.id, { code: "ISTATISTIK", type: "percent", value: 10 }, actor);
    const pumpId = createTestPump(station.id);

    redeemCode(station.id, "ISTATISTIK"); // live counter goes to 1, but no completed transaction yet
    db.prepare(
      `INSERT INTO transactions
        (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters, total_amount, status, kiosk_access_token, discount_code, discount_amount)
       VALUES (?, ?, '34TEST01', 'benzin', 'amount', 44.5, 10, 445, 'completed', 'tok', ?, ?)`
    ).run(station.id, pumpId, code.code, 44.5);

    const stats = getUsageStats(station.id);
    const entry = stats.get(code.id)!;
    expect(entry.completedUses).toBe(1);
    expect(entry.totalDiscountGiven).toBe(44.5);
    expect(entry.revenueGenerated).toBe(445 - 44.5);
  });
});
