import { db } from "../db/index.js";
import { broadcastPumps } from "./pumpService.js";
import { broadcastAlarms } from "./alarmService.js";
import { broadcast } from "../ws/hub.js";

/**
 * Bir istasyonun islem/alarm gecmisini ve pompa durumlarini baslangic durumuna dondurur.
 * Yalnizca belirtilen istasyon etkilenir; diger istasyonlarin verisi degismez.
 * Kullanicilar, roller ve denetim gunlugu (audit log) korunur.
 */
export function resetDemoData(stationId: number): void {
  const reset = db.transaction(() => {
    // fuel_stock_movements/loyalty_movements.transaction_id, transactions(id)'e FK ile
    // bagli oldugundan (ON DELETE CASCADE yok), once hareket kayitlari, sonra islemler
    // silinmeli - aksi halde tamamlanmis bir satisin hareket kaydi asilda kalip
    // SQLITE_CONSTRAINT_FOREIGNKEY ile silme islemini bastan sona basarisiz kilar.
    db.prepare("DELETE FROM fuel_stock_movements WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM loyalty_movements WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM loyalty_accounts WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM discount_codes WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM transactions WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM alarms WHERE station_id = ?").run(stationId);
    db.prepare(
      "UPDATE pumps SET status = 'idle', fault_code = NULL, fault_message = NULL, current_transaction_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE station_id = ?"
    ).run(stationId);
    db.prepare(
      `UPDATE fuel_prices SET price_per_liter = CASE fuel_type
         WHEN 'benzin' THEN 44.50
         WHEN 'motorin' THEN 43.20
         WHEN 'lpg' THEN 21.90
         ELSE price_per_liter END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE station_id = ?`
    ).run(stationId);
    db.prepare(
      "UPDATE fuel_tanks SET current_liters = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE station_id = ?"
    ).run(stationId);
  });
  reset();

  broadcastPumps(stationId);
  broadcastAlarms(stationId);
  broadcast(`transactions:${stationId}`, { reset: true });
  broadcast(`fuel-stock:${stationId}`, { reset: true });
}
