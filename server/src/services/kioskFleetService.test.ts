import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { AlarmRow, StationRow } from "../db/types.js";
import { createTestStation } from "../test/dbFixture.js";
import {
  checkOfflineKiosks,
  kioskStatus,
  listKioskFleet,
  summarizeKioskFleet,
} from "./kioskFleetService.js";

let station: StationRow;

function addKiosk(stationId: number, label: string, lastSeenAt: string | null): number {
  const r = db
    .prepare("INSERT INTO station_kiosks (station_id, label, device_token, last_seen_at) VALUES (?, ?, ?, ?)")
    .run(stationId, label, `tok-${Math.random().toString(16).slice(2)}`, lastSeenAt);
  return r.lastInsertRowid as number;
}

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function offlineAlarms(stationId: number): AlarmRow[] {
  return db
    .prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = 'kiosk_offline' ORDER BY id ASC")
    .all(stationId);
}

beforeEach(() => {
  station = createTestStation();
});

describe("kioskStatus", () => {
  it("yakin zamanda baglanan kiosk cevrimicidir", () => {
    expect(kioskStatus(minutesAgo(2))).toBe("online");
  });

  it("esigi asan kiosk cevrimdisidir", () => {
    expect(kioskStatus(minutesAgo(30))).toBe("offline");
  });

  it("hic baglanmamis kiosk ariza degil, kurulmamis sayilir", () => {
    // Kaydi acilmis ama kurulum adresi henuz cihaza uygulanmamis kiosk. Bunu
    // "cevrimdisi" saymak her yeni kayitta yanlis alarm uretirdi.
    expect(kioskStatus(null)).toBe("never_seen");
  });
});

describe("listKioskFleet / summarizeKioskFleet", () => {
  it("istasyonlar arasi tum kiosk'lari durumlariyla birlikte ozetler", () => {
    const other = createTestStation();
    addKiosk(station.id, "Ada 1", minutesAgo(1));
    addKiosk(station.id, "Ada 2", minutesAgo(45));
    addKiosk(other.id, "Ada 1", null);

    const mine = listKioskFleet().filter((k) => k.station_id === station.id || k.station_id === other.id);
    const summary = summarizeKioskFleet(mine);

    expect(summary.total).toBe(3);
    expect(summary.online).toBe(1);
    expect(summary.offline).toBe(1);
    expect(summary.neverSeen).toBe(1);
  });

  it("istasyondaki acik donanim arizasini o istasyonun kiosk'larina yansitir", () => {
    addKiosk(station.id, "Ada 1", minutesAgo(1));
    db.prepare("INSERT INTO alarms (station_id, type, severity, message) VALUES (?, 'printer_fault', 'critical', 'test')").run(station.id);

    const row = listKioskFleet().find((k) => k.station_id === station.id)!;
    expect(row.station_fault_alarms).toBe(1);
    expect(summarizeKioskFleet([row]).stationsWithFault).toBe(1);
  });

  it("cozulmus ariza alarmini saymaz", () => {
    addKiosk(station.id, "Ada 1", minutesAgo(1));
    db.prepare(
      "INSERT INTO alarms (station_id, type, severity, message, status) VALUES (?, 'printer_fault', 'critical', 'test', 'resolved')"
    ).run(station.id);

    expect(listKioskFleet().find((k) => k.station_id === station.id)!.station_fault_alarms).toBe(0);
  });
});

describe("checkOfflineKiosks", () => {
  it("cevrimdisi kalan kiosk icin alarm acar", () => {
    const id = addKiosk(station.id, "Pompa 1-2 Adasi", minutesAgo(30));

    checkOfflineKiosks();

    const alarms = offlineAlarms(station.id);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.severity).toBe("warning");
    expect(alarms[0]!.message).toContain(`#${id} `);
    expect(alarms[0]!.message).toContain("Pompa 1-2 Adasi");
  });

  it("ayni kiosk icin tekrar tekrar alarm uretmez", () => {
    addKiosk(station.id, "Ada 1", minutesAgo(30));

    checkOfflineKiosks();
    checkOfflineKiosks();
    checkOfflineKiosks();

    expect(offlineAlarms(station.id)).toHaveLength(1);
  });

  it("ayni istasyondaki farkli kiosk'lar icin ayri alarm uretir", () => {
    // Alarm tablosunda kiosk kolonu olmadigindan ayrim mesajdaki "#<id>" ile yapilir;
    // bu test o ayrimin gercekten calistigini dogrular.
    addKiosk(station.id, "Ada 1", minutesAgo(30));
    addKiosk(station.id, "Ada 2", minutesAgo(30));

    checkOfflineKiosks();

    expect(offlineAlarms(station.id)).toHaveLength(2);
  });

  it("hic baglanmamis kiosk icin alarm uretmez", () => {
    addKiosk(station.id, "Kurulum bekleyen", null);

    checkOfflineKiosks();

    expect(offlineAlarms(station.id)).toHaveLength(0);
  });

  it("pasif istasyonun kiosk'u icin alarm uretmez", () => {
    // Devre disi birakilmis istasyonun kiosk'unun kapali olmasi beklenen durumdur.
    addKiosk(station.id, "Ada 1", minutesAgo(30));
    db.prepare("UPDATE stations SET active = 0 WHERE id = ?").run(station.id);

    checkOfflineKiosks();

    expect(offlineAlarms(station.id)).toHaveLength(0);
  });

  it("kiosk geri donunce alarmi kendiliginden kapatir", () => {
    const id = addKiosk(station.id, "Ada 1", minutesAgo(30));
    checkOfflineKiosks();
    expect(offlineAlarms(station.id)[0]!.status).toBe("active");

    db.prepare("UPDATE station_kiosks SET last_seen_at = ? WHERE id = ?").run(minutesAgo(0), id);
    checkOfflineKiosks();

    const alarms = offlineAlarms(station.id);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.status).toBe("resolved");
    expect(alarms[0]!.resolved_at).not.toBeNull();
  });

  it("kiosk tekrar duserse yeni bir alarm acar", () => {
    const id = addKiosk(station.id, "Ada 1", minutesAgo(30));
    checkOfflineKiosks();
    db.prepare("UPDATE station_kiosks SET last_seen_at = ? WHERE id = ?").run(minutesAgo(0), id);
    checkOfflineKiosks();

    db.prepare("UPDATE station_kiosks SET last_seen_at = ? WHERE id = ?").run(minutesAgo(30), id);
    checkOfflineKiosks();

    const alarms = offlineAlarms(station.id);
    expect(alarms).toHaveLength(2);
    expect(alarms[1]!.status).toBe("active");
  });
});
