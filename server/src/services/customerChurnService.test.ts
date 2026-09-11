import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestPump, createTestStation } from "../test/dbFixture.js";
import type { StationRow } from "../db/types.js";
import { getChurnRiskCustomers } from "./customerChurnService.js";

let station: StationRow;
let pumpId: number;

function insertTransaction(plate: string, daysAgo: number, status = "completed"): void {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO transactions
       (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, total_amount, discount_amount, dispensed_liters, status, kiosk_access_token, created_at, completed_at)
     VALUES (?, ?, ?, 'benzin', 'amount', 44.5, 100, 0, 10, ?, ?, ?, ?)`
  ).run(station.id, pumpId, plate, status, `tok-${plate}-${daysAgo}-${Math.random()}`, at, status === "completed" ? at : null);
}

beforeEach(() => {
  station = createTestStation();
  pumpId = createTestPump(station.id);
});

describe("getChurnRiskCustomers", () => {
  it("duzenli gelip UZUN SUREDIR gelmeyen musteriyi listeler", () => {
    insertTransaction("34ABC01", 200);
    insertTransaction("34ABC01", 150);
    insertTransaction("34ABC01", 100);

    const rows = getChurnRiskCustomers(station.id, { minVisits: 3, inactiveDays: 30 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plate).toBe("34ABC01");
    expect(rows[0]!.visitCount).toBe(3);
    expect(rows[0]!.daysSinceLastVisit).toBeGreaterThanOrEqual(100);
  });

  it("YAKIN ZAMANDA gelmis duzenli musteriyi listelemez", () => {
    insertTransaction("34ABC02", 40);
    insertTransaction("34ABC02", 20);
    insertTransaction("34ABC02", 5);

    const rows = getChurnRiskCustomers(station.id, { minVisits: 3, inactiveDays: 30 });
    expect(rows).toHaveLength(0);
  });

  it("minVisits esigini gecmeyen (duzenli SAYILMAYAN) plakayi listelemez", () => {
    insertTransaction("34ABC03", 200);
    insertTransaction("34ABC03", 100);

    const rows = getChurnRiskCustomers(station.id, { minVisits: 3, inactiveDays: 30 });
    expect(rows).toHaveLength(0);
  });

  it("filo hesabina atanmis bir plakayi HARIC TUTAR", () => {
    const fleetAccountId = db
      .prepare("INSERT INTO fleet_accounts (station_id, company_name, credit_limit, balance) VALUES (?, 'Test Filo', 10000, 0)")
      .run(station.id).lastInsertRowid as number;
    db.prepare("INSERT INTO fleet_plates (fleet_account_id, plate) VALUES (?, '34FLEET1')").run(fleetAccountId);

    insertTransaction("34FLEET1", 200);
    insertTransaction("34FLEET1", 150);
    insertTransaction("34FLEET1", 100);

    const rows = getChurnRiskCustomers(station.id, { minVisits: 3, inactiveDays: 30 });
    expect(rows.find((r) => r.plate === "34FLEET1")).toBeUndefined();
  });

  it("sadece TAMAMLANMIS islemleri sayar", () => {
    insertTransaction("34ABC04", 200, "completed");
    insertTransaction("34ABC04", 150, "cancelled");
    insertTransaction("34ABC04", 100, "completed");

    const rows = getChurnRiskCustomers(station.id, { minVisits: 3, inactiveDays: 30 });
    expect(rows.find((r) => r.plate === "34ABC04")).toBeUndefined();

    const rowsLower = getChurnRiskCustomers(station.id, { minVisits: 2, inactiveDays: 30 });
    expect(rowsLower.find((r) => r.plate === "34ABC04")!.visitCount).toBe(2);
  });

  it("en cok ziyaret eden once, esitlikte en uzun suredir gelmeyen once siralanir", () => {
    insertTransaction("34ABC05", 200);
    insertTransaction("34ABC05", 150);
    insertTransaction("34ABC05", 100);
    insertTransaction("34ABC06", 300);
    insertTransaction("34ABC06", 250);
    insertTransaction("34ABC06", 200);
    insertTransaction("34ABC06", 150);

    const rows = getChurnRiskCustomers(station.id, { minVisits: 3, inactiveDays: 30 });
    expect(rows[0]!.plate).toBe("34ABC06");
    expect(rows[1]!.plate).toBe("34ABC05");
  });

  it("baska bir istasyonun musterilerini karistirmaz", () => {
    const other = createTestStation();
    const otherPump = createTestPump(other.id);
    db.prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, total_amount, discount_amount, dispensed_liters, status, kiosk_access_token, created_at, completed_at)
       VALUES (?, ?, '34OTHER1', 'benzin', 'amount', 44.5, 100, 0, 10, 'completed', 'tok-other', ?, ?)`
    ).run(other.id, otherPump, new Date(Date.now() - 200 * 86_400_000).toISOString(), new Date(Date.now() - 200 * 86_400_000).toISOString());

    const rows = getChurnRiskCustomers(station.id, { minVisits: 1, inactiveDays: 30 });
    expect(rows.find((r) => r.plate === "34OTHER1")).toBeUndefined();
  });
});
