import { describe, expect, it } from "vitest";
import { backfillNormalizedPlates, db } from "./index.js";
import { createTestStation } from "../test/dbFixture.js";

/**
 * Gercek uretim veritabaninda, ayni plakanin FARKLI bosluklu iki kaydi, hangisinin
 * once eklendigine (dusuk id/rowid) bagli olarak iki farkli sirada bulunabilir:
 * ya normalize-EDILMEMIS kayit ya da normalize-EDILMIS kayit once gelir. Eski
 * migration kodu yalnizca "once gordugunu kanonik say" seklinde tek-gecisliydi;
 * normalize-edilmemis kayit dusuk id'deyse, onu normalize etmeye calisirken
 * ZATEN VAR OLAN (yuksek id'li, onceden normalize) kayitla UNIQUE/PK ihlaline
 * girip transaction'i (dolayisiyla applyMigrations()'i, dolayisiyla sunucu
 * aciligini) coktururdu. Bu testler tam bu sirayi (dusuk id = normalize-edilmemis)
 * kurup migration'in artik guvenle tamamlandigini dogrular.
 */
function createFleetAccount(stationId: number): number {
  return db
    .prepare("INSERT INTO fleet_accounts (station_id, company_name, billing_type) VALUES (?, 'Test Filo', 'prepaid')")
    .run(stationId).lastInsertRowid as number;
}

describe("backfillNormalizedPlates", () => {
  it("fleet_plates: normalize-edilmemis kayit ONCE eklenmisse (dusuk id) UNIQUE ihlaline girmeden birlesir", () => {
    const station = createTestStation();
    const accountId = createFleetAccount(station.id);
    // Dusuk id: henuz normalize edilmemis (bosluklu) kayit.
    db.prepare("INSERT INTO fleet_plates (fleet_account_id, plate) VALUES (?, ?)").run(accountId, "06 VY 894");
    // Yuksek id: ayni plakanin ONCEDEN normalize edilmis hali.
    db.prepare("INSERT INTO fleet_plates (fleet_account_id, plate, expected_fuel_type) VALUES (?, ?, 'motorin')").run(accountId, "06VY894");

    expect(() => backfillNormalizedPlates()).not.toThrow();

    const rows = db.prepare("SELECT plate, expected_fuel_type FROM fleet_plates WHERE fleet_account_id = ?").all(accountId) as Array<{
      plate: string;
      expected_fuel_type: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plate).toBe("06VY894");
    expect(rows[0]!.expected_fuel_type).toBe("motorin");
  });

  it("loyalty_accounts: normalize-edilmemis kayit ONCE eklenmisse (dusuk rowid) PK ihlaline girmeden puanlar toplanir", () => {
    const station = createTestStation();
    // Dusuk rowid: henuz normalize edilmemis (bosluklu) kayit.
    db.prepare("INSERT INTO loyalty_accounts (station_id, plate, points) VALUES (?, ?, ?)").run(station.id, "06 VY 894", 10);
    // Yuksek rowid: ayni plakanin ONCEDEN normalize edilmis hali.
    db.prepare("INSERT INTO loyalty_accounts (station_id, plate, points) VALUES (?, ?, ?)").run(station.id, "06VY894", 5);

    expect(() => backfillNormalizedPlates()).not.toThrow();

    const rows = db.prepare("SELECT plate, points FROM loyalty_accounts WHERE station_id = ?").all(station.id) as Array<{
      plate: string;
      points: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plate).toBe("06VY894");
    expect(rows[0]!.points).toBe(15);
  });

  it("collision yoksa yalniz basina bosluklu plakayi sessizce normalize eder", () => {
    const station = createTestStation();
    const accountId = createFleetAccount(station.id);
    db.prepare("INSERT INTO fleet_plates (fleet_account_id, plate) VALUES (?, ?)").run(accountId, "34  abc  12");

    backfillNormalizedPlates();

    const row = db.prepare("SELECT plate FROM fleet_plates WHERE fleet_account_id = ?").get(accountId) as { plate: string };
    expect(row.plate).toBe("34ABC12");
  });
});
