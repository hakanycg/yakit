import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import {
  MAX_PERMISSIBLE_ERROR_PCT,
  PumpCalibrationError,
  checkExpiringSeals,
  evaluateCalibration,
  getStationCalibrationStatus,
  listCalibrations,
  recordCalibration,
} from "./pumpCalibrationService.js";

let station: StationRow;
let actor: UserRow;
let pumpId: number;
const DAY = 86400000;

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * DAY).toISOString();
}

function activeAlarms(type: string): { message: string; severity: string }[] {
  return db
    .prepare<[number, string], { message: string; severity: string }>(
      "SELECT message, severity FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved'"
    )
    .all(station.id, type);
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  pumpId = createTestPump(station.id);
});

describe("hata hesabi", () => {
  it("hatayi AYAR KABINA gore hesaplar, sayac okumasina gore degil", () => {
    // Hatanin buyuklugu, gercekte ne kadar yakit verildigine gore anlamlidir - pompanin
    // kendi (hatali) rakamina gore degil. 10 L kap, sayac 10.1 gosterdi: %1.
    expect(evaluateCalibration(10, 10.1).errorPct).toBe(1);
  });

  it("pompa FAZLA gosterdiginde hata artidir (musteri aleyhine)", () => {
    const e = evaluateCalibration(20, 20.2);
    expect(e.errorLiters).toBe(0.2);
    expect(e.errorPct).toBe(1);
  });

  it("pompa EKSIK gosterdiginde hata eksidir (isletme aleyhine)", () => {
    expect(evaluateCalibration(20, 19.8).errorPct).toBe(-1);
  });

  it("tolerans icindeki hatayi gecerli sayar", () => {
    expect(evaluateCalibration(20, 20.05).withinTolerance).toBe(true); // %0.25
  });

  it("tam sinirdaki hatayi gecerli sayar, asani saymaz", () => {
    expect(evaluateCalibration(1000, 1005).withinTolerance).toBe(true); // tam %0.5
    expect(evaluateCalibration(1000, 1006).withinTolerance).toBe(false); // %0.6
  });

  it("her 1000 litredeki farki aritmetik olarak verir", () => {
    // Tahmin degil dogrudan hesap: %0.3 hata, 1000 L'de 3 L eder.
    expect(evaluateCalibration(10, 10.03).litersPerThousand).toBe(3);
  });

  it("gecersiz girdiyi reddeder", () => {
    expect(() => evaluateCalibration(0, 10)).toThrow(PumpCalibrationError);
    expect(() => evaluateCalibration(10, -1)).toThrow(PumpCalibrationError);
  });

  it("yasal sinir %0.5", () => {
    expect(MAX_PERMISSIBLE_ERROR_PCT).toBe(0.5);
  });
});

describe("test kaydi", () => {
  it("kaydi ve hesaplanan hatayi saklar", () => {
    const c = recordCalibration(station.id, pumpId, { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20.05 }, actor);

    expect(c.error_pct).toBe(0.25);
    expect(c.within_tolerance).toBe(1);
    expect(listCalibrations(station.id, pumpId)).toHaveLength(1);
  });

  it("tolerans disinda KRITIK alarm uretir ve yonunu yazar", () => {
    recordCalibration(station.id, pumpId, { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20.4 }, actor);

    const alarms = activeAlarms("pump_calibration_out_of_tolerance");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.severity).toBe("critical");
    expect(alarms[0]!.message).toContain("musteri aleyhine");
    expect(alarms[0]!.message).toContain("±%0.5");
  });

  it("isletme aleyhine sapmayi da yakalar", () => {
    recordCalibration(station.id, pumpId, { fuelType: "motorin", referenceLiters: 20, meteredLiters: 19.6 }, actor);

    expect(activeAlarms("pump_calibration_out_of_tolerance")[0]!.message).toContain("isletme aleyhine");
  });

  it("tolerans icindeyken alarm uretmez", () => {
    recordCalibration(station.id, pumpId, { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20.05 }, actor);

    expect(activeAlarms("pump_calibration_out_of_tolerance")).toHaveLength(0);
  });

  it("baska istasyonun pompasina kayit girmeyi reddeder", () => {
    const other = createTestStation();
    expect(() =>
      recordCalibration(other.id, pumpId, { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20 }, actor)
    ).toThrow(PumpCalibrationError);
  });
});

describe("istasyon durumu", () => {
  it("hic testi olmayan pompayi null degerlerle listeler", () => {
    // "Test edilmedi" ile "test edildi, gecti" ayni sey degildir.
    const status = getStationCalibrationStatus(station.id).find((p) => p.pumpId === pumpId)!;

    expect(status.lastTestedAt).toBeNull();
    expect(status.withinTolerance).toBeNull();
    expect(status.sealStatus).toBe("unknown");
  });

  it("yalnizca EN SON testi dikkate alir", () => {
    // "Pompa su anda yasal mi" sorusunun cevabi en sonuncusudur.
    recordCalibration(station.id, pumpId, { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20.4 }, actor);
    db.prepare("UPDATE pump_calibrations SET tested_at = ? WHERE pump_id = ?").run(daysFromNow(-10), pumpId);
    recordCalibration(station.id, pumpId, { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20.02 }, actor);

    const status = getStationCalibrationStatus(station.id).find((p) => p.pumpId === pumpId)!;

    expect(status.withinTolerance).toBe(true);
    expect(status.lastErrorPct).toBe(0.1);
  });

  it("damga durumunu ve kalan gunu hesaplar", () => {
    recordCalibration(
      station.id,
      pumpId,
      { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20, sealValidUntil: daysFromNow(200) },
      actor
    );

    const status = getStationCalibrationStatus(station.id).find((p) => p.pumpId === pumpId)!;

    expect(status.sealStatus).toBe("valid");
    expect(status.sealDaysRemaining).toBeGreaterThan(190);
  });

  it("bitisine az kalan damgayi 'expiring' isaretler", () => {
    recordCalibration(
      station.id,
      pumpId,
      { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20, sealValidUntil: daysFromNow(10) },
      actor
    );

    expect(getStationCalibrationStatus(station.id).find((p) => p.pumpId === pumpId)!.sealStatus).toBe("expiring");
  });

  it("suresi dolmus damgayi 'expired' isaretler", () => {
    recordCalibration(
      station.id,
      pumpId,
      { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20, sealValidUntil: daysFromNow(-5) },
      actor
    );

    const status = getStationCalibrationStatus(station.id).find((p) => p.pumpId === pumpId)!;
    expect(status.sealStatus).toBe("expired");
    expect(status.sealDaysRemaining).toBeLessThan(0);
  });
});

describe("damga taramasi", () => {
  it("suresi dolmus damga icin KRITIK alarm uretir", () => {
    recordCalibration(
      station.id,
      pumpId,
      { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20, sealValidUntil: daysFromNow(-5) },
      actor
    );

    checkExpiringSeals();

    const alarms = activeAlarms("pump_seal_expiring");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.severity).toBe("critical");
    expect(alarms[0]!.message).toContain("DOLDU");
  });

  it("yaklasan damga icin UYARI uretir", () => {
    recordCalibration(
      station.id,
      pumpId,
      { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20, sealValidUntil: daysFromNow(10) },
      actor
    );

    checkExpiringSeals();

    expect(activeAlarms("pump_seal_expiring")[0]!.severity).toBe("warning");
  });

  it("damga tarihi GIRILMEMIS pompaya alarm uretmez", () => {
    // Veriyi girmemis her istasyonu alarma bogmak, ozelligi kullanilamaz kilardi.
    recordCalibration(station.id, pumpId, { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20 }, actor);

    checkExpiringSeals();

    expect(activeAlarms("pump_seal_expiring")).toHaveLength(0);
  });

  it("ayni pompa icin ikinci alarm acmaz", () => {
    recordCalibration(
      station.id,
      pumpId,
      { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20, sealValidUntil: daysFromNow(-5) },
      actor
    );

    checkExpiringSeals();
    checkExpiringSeals();

    expect(activeAlarms("pump_seal_expiring")).toHaveLength(1);
  });

  it("damga yenilenince alarm kendiliginden cozulur", () => {
    recordCalibration(
      station.id,
      pumpId,
      { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20, sealValidUntil: daysFromNow(-5) },
      actor
    );
    checkExpiringSeals();
    expect(activeAlarms("pump_seal_expiring")).toHaveLength(1);

    recordCalibration(
      station.id,
      pumpId,
      { fuelType: "motorin", referenceLiters: 20, meteredLiters: 20, sealValidUntil: daysFromNow(365) },
      actor
    );
    checkExpiringSeals();

    expect(activeAlarms("pump_seal_expiring")).toHaveLength(0);
  });
});
