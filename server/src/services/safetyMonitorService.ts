import { db } from "../db/index.js";
import type { StationRow } from "../db/types.js";
import { getSafetySensorDriver } from "./safetySensorDriver.js";
import { emergencyStopStation } from "./transactionService.js";
import { logger } from "../utils/logger.js";

/**
 * Periyodik olarak (bkz. index.ts) her aktif istasyon icin SafetySensorDriver'i
 * sorgular. Alarm aktifse ve istasyonda zaten aktif bir "emergency_stop" alarmi
 * yoksa (ör. operator zaten butona basmis veya bu kontrol daha once tetiklenmisse
 * tekrar tekrar durdurmaya gerek yok), istasyon genelinde acil durdurma tetikler
 * (bkz. emergencyStopStation). Gorevlinin sahada olmadigi (Faz 2) senaryoda, fiziksel
 * mudahalenin yerini alan otomatik tepki budur.
 */
export function checkSafetySensors(): void {
  const driver = getSafetySensorDriver();
  const stations = db.prepare<[], StationRow>("SELECT * FROM stations WHERE active = 1").all();

  for (const station of stations) {
    const reason = driver.checkAlarm(station.id);
    if (!reason) continue;

    const activeAlarm = db
      .prepare<[number, string], { id: number }>("SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status = 'active' LIMIT 1")
      .get(station.id, "emergency_stop");
    if (activeAlarm) continue;

    try {
      emergencyStopStation(station.id, null, reason);
    } catch (err) {
      logger.error({ err, stationId: station.id }, "Guvenlik sensoru kaynakli otomatik acil durdurma basarisiz.");
    }
  }
}
