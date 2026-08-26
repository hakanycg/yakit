import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { AlarmRow } from "../db/types.js";
import { createTestFuelPrice, createTestPump, createTestStation, setTankStock } from "../test/dbFixture.js";
import { getSafetySensorDriver, noopSafetySensorDriver, setSafetySensorDriver } from "./safetySensorDriver.js";
import { checkSafetySensors } from "./safetyMonitorService.js";
import { createTransaction, finalizeTransactionPayment } from "./transactionService.js";

/** Testlerde "odeme onaylandi" noktasina gecmek icin: gercek saglayici cagrisi yapilmaz. */
function payOk(id: number) {
  return finalizeTransactionPayment(id, { success: true, reference: "TEST-OK", message: "Odeme onaylandi." });
}

describe("checkSafetySensors", () => {
  afterEach(() => {
    // Testler arasi surucuyu her zaman varsayilana (noop) geri dondur - aksi halde bir
    // testin taktigi sahte surucu sonraki testleri etkiler.
    setSafetySensorDriver(noopSafetySensorDriver);
  });

  it("does nothing when the driver reports no alarm (default noop driver)", () => {
    const station = createTestStation();
    createTestPump(station.id);
    expect(() => checkSafetySensors()).not.toThrow();
    const alarms = db.prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?").all(station.id, "emergency_stop");
    expect(alarms.length).toBe(0);
  });

  it("triggers a station-wide emergency stop when the driver reports an active alarm", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id, ["benzin"]);
    setSafetySensorDriver({ checkAlarm: (stationId) => (stationId === station.id ? "Yangin alarm sistemi tetiklendi." : null) });

    checkSafetySensors();

    const pump = db.prepare("SELECT status, fault_code FROM pumps WHERE id = ?").get(pumpId) as { status: string; fault_code: string | null };
    expect(pump.status).toBe("fault");
    expect(pump.fault_code).toBe("EMERGENCY_STOP");

    const alarms = db.prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?").all(station.id, "emergency_stop");
    expect(alarms.length).toBe(1);
    expect(alarms[0]!.message).toContain("Yangin alarm sistemi tetiklendi.");
  });

  it("stops an active transaction too and does not require a human actor", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id, ["benzin"]);
    createTestFuelPrice(station.id, "benzin", 44.5);
    setTankStock(station.id, "benzin", 500);

    const { transaction } = createTransaction({ pumpId, plate: "34SAF001", plateSource: "manual", fuelType: "benzin", amountMode: "liters", requestedLiters: 5 });
    payOk(transaction.id);

    setSafetySensorDriver({ checkAlarm: () => "Test: gaz sizintisi tespit edildi." });
    checkSafetySensors();

    const stopped = db.prepare("SELECT status FROM transactions WHERE id = ?").get(transaction.id) as { status: string };
    expect(stopped.status).toBe("cancelled");

    const auditRow = db
      .prepare("SELECT user_id FROM audit_log WHERE action = 'station_emergency_stop' AND station_id = ? ORDER BY id DESC LIMIT 1")
      .get(station.id) as { user_id: number | null };
    expect(auditRow.user_id).toBeNull();
  });

  it("does not re-trigger if an emergency_stop alarm is already active for the station", () => {
    const station = createTestStation();
    createTestPump(station.id, ["benzin"]);
    setSafetySensorDriver({ checkAlarm: () => "Test: tekrar tetiklenmemeli." });

    checkSafetySensors();
    checkSafetySensors();

    const alarms = db.prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?").all(station.id, "emergency_stop");
    expect(alarms.length).toBe(1);
  });

  it("getSafetySensorDriver reflects the currently active driver", () => {
    const custom = { checkAlarm: () => null };
    setSafetySensorDriver(custom);
    expect(getSafetySensorDriver()).toBe(custom);
  });
});
