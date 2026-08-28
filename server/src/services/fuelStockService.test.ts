import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import type { StationRow, UserRow } from "../db/types.js";
import {
  DuplicateDeliveryRefError,
  addStock,
  adjustStock,
  deductAvailable,
  getSupplierSummary,
  listTanks,
} from "./fuelStockService.js";

describe("fuelStockService", () => {
  let station: StationRow;
  let actor: UserRow;

  beforeEach(() => {
    station = createTestStation();
    actor = createTestUser(station.id);
  });

  it("adds stock and increases the tank level", () => {
    const { tank, overflow } = addStock(station.id, "benzin", 1000, { supplier: "Test Tedarikci" }, actor);
    expect(tank.current_liters).toBe(1000);
    expect(overflow).toBe(0);
  });

  it("clamps additions that exceed tank capacity and reports the overflow amount", () => {
    // benzin tank capacity is 10000 per the fixture
    const { tank, overflow } = addStock(station.id, "benzin", 12000, { supplier: "Test Tedarikci" }, actor);
    expect(tank.current_liters).toBe(10000);
    expect(overflow).toBe(2000);
  });

  it("computes a weighted average cost across deliveries at different unit costs", () => {
    addStock(station.id, "benzin", 1000, { supplier: "Tedarikci A", unitCost: 38.5 }, actor);
    const { tank } = addStock(station.id, "benzin", 1000, { supplier: "Tedarikci B", unitCost: 40.5 }, actor);
    // (1000*38.5 + 1000*40.5) / 2000 = 39.5
    expect(tank.average_cost_per_liter).toBeCloseTo(39.5, 4);
  });

  it("leaves the average cost unchanged for deliveries without a unit cost", () => {
    addStock(station.id, "benzin", 1000, { supplier: "Tedarikci A", unitCost: 38.5 }, actor);
    const { tank } = addStock(station.id, "benzin", 1000, { supplier: "Tedarikci B" }, actor);
    expect(tank.average_cost_per_liter).toBeCloseTo(38.5, 4);
  });

  it("rejects a duplicate delivery ref for the same fuel type, unless forced", () => {
    addStock(station.id, "benzin", 500, { supplier: "Tedarikci A", deliveryRef: "IRS-001" }, actor);
    expect(() => addStock(station.id, "benzin", 500, { supplier: "Tedarikci A", deliveryRef: "IRS-001" }, actor)).toThrow(
      DuplicateDeliveryRefError
    );
    // force:true bypasses the check
    expect(() =>
      addStock(station.id, "benzin", 500, { supplier: "Tedarikci A", deliveryRef: "IRS-001", force: true }, actor)
    ).not.toThrow();
  });

  it("allows the same delivery ref across different fuel types", () => {
    addStock(station.id, "benzin", 500, { supplier: "Tedarikci A", deliveryRef: "IRS-002" }, actor);
    expect(() => addStock(station.id, "motorin", 500, { supplier: "Tedarikci A", deliveryRef: "IRS-002" }, actor)).not.toThrow();
  });

  it("deducts available stock and reports when the tank was insufficient", () => {
    addStock(station.id, "benzin", 100, { supplier: "Tedarikci A" }, actor);
    const full = deductAvailable(station.id, "benzin", 60);
    expect(full.actual).toBe(60);
    expect(full.limited).toBe(false);

    const partial = deductAvailable(station.id, "benzin", 60);
    // only 40 liters remained
    expect(partial.actual).toBeCloseTo(40, 2);
    expect(partial.limited).toBe(true);
  });

  it("adjustStock clamps to capacity and records the delta as an adjustment", () => {
    const tank = adjustStock(station.id, "benzin", 9000, "Fiziksel olcum", actor);
    expect(tank.current_liters).toBe(9000);

    const clamped = adjustStock(station.id, "benzin", 999999, "Asiri deger", actor);
    expect(clamped.current_liters).toBe(10000); // capacity
  });

  it("rejects a negative adjustment target", () => {
    expect(() => adjustStock(station.id, "benzin", -1, "Gecersiz", actor)).toThrow();
  });

  it("listTanks returns all three fuel types for a station", () => {
    const tanks = listTanks(station.id);
    expect(tanks.map((t) => t.fuel_type).sort()).toEqual(["benzin", "lpg", "motorin"]);
  });

  it("getSupplierSummary aggregates deliveries per supplier and fuel type", () => {
    addStock(station.id, "benzin", 1000, { supplier: "Tedarikci A", unitCost: 38.5 }, actor);
    addStock(station.id, "benzin", 500, { supplier: "Tedarikci A", unitCost: 40 }, actor);
    addStock(station.id, "motorin", 200, { supplier: "Tedarikci A" }, actor);

    const summary = getSupplierSummary(station.id);
    const benzinRow = summary.find((r) => r.supplier === "Tedarikci A" && r.fuelType === "benzin");
    expect(benzinRow).toBeDefined();
    expect(benzinRow!.deliveryCount).toBe(2);
    expect(benzinRow!.totalLiters).toBe(1500);
    // (1000*38.5 + 500*40) / 1500 = 39.0
    expect(benzinRow!.avgUnitCost).toBeCloseTo(39, 4);

    const motorinRow = summary.find((r) => r.supplier === "Tedarikci A" && r.fuelType === "motorin");
    expect(motorinRow!.avgUnitCost).toBeNull(); // no unit cost given for this delivery
  });

  it("getSupplierSummary tarih araligina gore filtreler", () => {
    addStock(station.id, "benzin", 1000, { supplier: "Eski Tedarikci" }, actor);
    db.prepare("UPDATE fuel_stock_movements SET created_at = ? WHERE station_id = ? AND supplier = ?").run(
      "2026-01-05T10:00:00.000Z",
      station.id,
      "Eski Tedarikci"
    );
    addStock(station.id, "benzin", 500, { supplier: "Yeni Tedarikci" }, actor);
    db.prepare("UPDATE fuel_stock_movements SET created_at = ? WHERE station_id = ? AND supplier = ?").run(
      "2026-03-10T10:00:00.000Z",
      station.id,
      "Yeni Tedarikci"
    );

    const janOnly = getSupplierSummary(station.id, "2026-01-01", "2026-01-31");
    expect(janOnly.map((r) => r.supplier)).toEqual(["Eski Tedarikci"]);

    const marOnly = getSupplierSummary(station.id, "2026-03-01", "2026-03-31");
    expect(marOnly.map((r) => r.supplier)).toEqual(["Yeni Tedarikci"]);

    const all = getSupplierSummary(station.id);
    expect(all.map((r) => r.supplier).sort()).toEqual(["Eski Tedarikci", "Yeni Tedarikci"]);
  });
});
