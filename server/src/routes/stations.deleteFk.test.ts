import { describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";

/**
 * routes/stations.ts DELETE /:id icindeki silme sirasi ile AYNI SQL dizisi (foreign_keys=ON
 * oldugu icin sira onemlidir). Supertest bu projede kullanilmiyor (route testleri servis
 * katmaninda yapiliyor) - bu yuzden route'u HTTP uzerinden degil, ayni transaction sirasini
 * dogrudan calistirarak dogruluyoruz. code-review'de bulunan gercek bir regresyon icin:
 * device_push_tokens (user_id NOT NULL FK) ve marketing_campaigns (station_id NOT NULL FK)
 * temizlenmeden DELETE FROM users / DELETE FROM stations calisirsa SQLITE_CONSTRAINT firlatir.
 */
function runStationDeleteTransaction(stationId: number, userIds: number[]): void {
  const del = db.transaction(() => {
    db.prepare("DELETE FROM alarms WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM shifts WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM pumps WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM fuel_prices WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM fuel_stock_movements WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM fuel_tanks WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM settings WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM station_sync_events WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM station_sync_state WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM station_kiosks WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM marketing_campaigns WHERE station_id = ?").run(stationId);

    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM device_push_tokens WHERE user_id IN (${placeholders})`).run(...userIds);
      db.prepare(`UPDATE audit_log SET user_id = NULL WHERE user_id IN (${placeholders})`).run(...userIds);
      db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...userIds);
    }

    db.prepare("UPDATE audit_log SET station_id = NULL WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM stations WHERE id = ?").run(stationId);
  });
  del();
}

describe("istasyon silme - FK guvenligi (bkz. routes/stations.ts DELETE /:id)", () => {
  it("kullanicinin kayitli push token'i varken istasyon silinebilir", () => {
    const station = createTestStation();
    const user = createTestUser(station.id, "admin");
    db.prepare("INSERT INTO device_push_tokens (user_id, token, platform) VALUES (?, ?, ?)").run(user.id, `tok-${user.id}`, "android");

    expect(() => runStationDeleteTransaction(station.id, [user.id])).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) as c FROM device_push_tokens WHERE user_id = ?").get(user.id)).toEqual({ c: 0 });
    expect(db.prepare("SELECT * FROM stations WHERE id = ?").get(station.id)).toBeUndefined();
  });

  it("istasyonun kampanya kaydi varken de silinebilir", () => {
    const station = createTestStation();
    db.prepare(
      "INSERT INTO marketing_campaigns (station_id, name, channel, message) VALUES (?, 'Test', 'email', 'Merhaba')"
    ).run(station.id);

    expect(() => runStationDeleteTransaction(station.id, [])).not.toThrow();
    expect(db.prepare("SELECT * FROM stations WHERE id = ?").get(station.id)).toBeUndefined();
  });
});
