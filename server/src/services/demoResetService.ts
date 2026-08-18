import { db } from "../db/index.js";
import { broadcastPumps } from "./pumpService.js";
import { broadcastAlarms } from "./alarmService.js";
import { broadcast } from "../ws/hub.js";

/**
 * Islem/alarm gecmisini ve pompa durumlarini baslangic durumuna dondurur.
 * Kullanicilar, roller ve denetim gunlugu (audit log) korunur.
 */
export function resetDemoData(): void {
  const reset = db.transaction(() => {
    db.exec("DELETE FROM transactions");
    db.exec("DELETE FROM alarms");
    db.exec(
      "UPDATE pumps SET status = 'idle', fault_code = NULL, fault_message = NULL, current_transaction_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    );
    db.exec(
      `UPDATE fuel_prices SET price_per_liter = CASE fuel_type
         WHEN 'benzin' THEN 44.50
         WHEN 'motorin' THEN 43.20
         WHEN 'lpg' THEN 21.90
         ELSE price_per_liter END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    );
  });
  reset();

  broadcastPumps();
  broadcastAlarms();
  broadcast("transactions", { reset: true });
}
