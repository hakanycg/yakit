import { describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { FuelPriceRow } from "../db/types.js";
import { createTestFuelPrice, createTestStation, createTestUser } from "../test/dbFixture.js";
import { ScheduledPriceError, applyDuePriceChanges, cancelSchedule, createSchedule, listSchedules } from "./scheduledPriceService.js";

function future(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

function currentPrice(stationId: number, fuelType: string): number {
  return db.prepare<[number, string], FuelPriceRow>("SELECT * FROM fuel_prices WHERE station_id = ? AND fuel_type = ?").get(stationId, fuelType)!.price_per_liter;
}

describe("scheduledPriceService", () => {
  it("rejects a schedule for an invalid fuel type", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    expect(() => createSchedule(station.id, "benzin", 50, future(60_000), admin)).toThrow(ScheduledPriceError);
  });

  it("rejects a schedule for a past/present time", () => {
    const station = createTestStation();
    createTestFuelPrice(station.id, "benzin", 44.5);
    const admin = createTestUser(station.id, "admin");
    expect(() => createSchedule(station.id, "benzin", 50, new Date(Date.now() - 1000).toISOString(), admin)).toThrow(ScheduledPriceError);
  });

  it("does not apply a schedule before its time comes", () => {
    const station = createTestStation();
    createTestFuelPrice(station.id, "benzin", 44.5);
    const admin = createTestUser(station.id, "admin");
    createSchedule(station.id, "benzin", 50, future(60 * 60 * 1000), admin);

    applyDuePriceChanges();
    expect(currentPrice(station.id, "benzin")).toBe(44.5);
  });

  it("applies a due schedule and records fuel_price_history", () => {
    const station = createTestStation();
    createTestFuelPrice(station.id, "benzin", 44.5);
    const admin = createTestUser(station.id, "admin");
    const schedule = createSchedule(station.id, "benzin", 47.9, future(10), admin);

    // Zamani "gecmis" yap (test icin bekleme yapmadan) - createSchedule gelecek zaman
    // sarti koydugu icin burada dogrudan DB'den geriye aliyoruz.
    db.prepare("UPDATE scheduled_price_changes SET scheduled_for = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), schedule.id);

    applyDuePriceChanges();
    expect(currentPrice(station.id, "benzin")).toBe(47.9);

    const updated = listSchedules(station.id).find((s) => s.id === schedule.id)!;
    expect(updated.status).toBe("applied");
    expect(updated.applied_at).not.toBeNull();

    const history = db
      .prepare<[number, string], { price_per_liter: number }>("SELECT price_per_liter FROM fuel_price_history WHERE station_id = ? AND fuel_type = ? ORDER BY id DESC LIMIT 1")
      .get(station.id, "benzin");
    expect(history?.price_per_liter).toBe(47.9);
  });

  it("cancelSchedule prevents a pending schedule from being applied later", () => {
    const station = createTestStation();
    createTestFuelPrice(station.id, "benzin", 44.5);
    const admin = createTestUser(station.id, "admin");
    const schedule = createSchedule(station.id, "benzin", 60, future(10), admin);
    cancelSchedule(station.id, schedule.id);

    db.prepare("UPDATE scheduled_price_changes SET scheduled_for = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), schedule.id);
    applyDuePriceChanges();

    expect(currentPrice(station.id, "benzin")).toBe(44.5);
  });

  it("cancelSchedule throws for an already-applied or unknown schedule", () => {
    const station = createTestStation();
    createTestFuelPrice(station.id, "benzin", 44.5);
    const admin = createTestUser(station.id, "admin");
    const schedule = createSchedule(station.id, "benzin", 60, future(10), admin);
    cancelSchedule(station.id, schedule.id);
    expect(() => cancelSchedule(station.id, schedule.id)).toThrow(ScheduledPriceError);
  });
});
