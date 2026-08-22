import { describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestPump, createTestStation } from "../test/dbFixture.js";
import { listAlarms } from "./alarmService.js";
import {
  checkOfflineStations,
  ensureSyncToken,
  getStationBySyncToken,
  getStationCacheSnapshot,
  getSyncState,
  recordHeartbeat,
  recordSyncEvent,
  rotateSyncToken,
} from "./syncService.js";

describe("syncService - token yonetimi", () => {
  it("bir token uretir ve sonraki cagrilarda aynisini doner", () => {
    const station = createTestStation();
    const first = ensureSyncToken(station.id);
    expect(first).toHaveLength(48);
    expect(ensureSyncToken(station.id)).toBe(first);
  });

  it("rotateSyncToken eskisini gecersiz kilan yeni bir token uretir", () => {
    const station = createTestStation();
    const first = ensureSyncToken(station.id);
    const second = rotateSyncToken(station.id);
    expect(second).not.toBe(first);
    expect(getStationBySyncToken(first)).toBeNull();
    expect(getStationBySyncToken(second)?.id).toBe(station.id);
  });

  it("gecersiz bir token icin null doner", () => {
    expect(getStationBySyncToken("olmayan-token")).toBeNull();
  });
});

describe("syncService - heartbeat ve olay kaydi", () => {
  it("heartbeat son senkron durumunu gunceller", () => {
    const station = createTestStation();
    expect(getSyncState(station.id)).toBeNull();
    recordHeartbeat(station.id);
    const state = getSyncState(station.id);
    expect(state?.last_heartbeat_at).not.toBeNull();
  });

  it("ayni client_event_id ile tekrar gonderilen bir olayi tekillestirir (idempotency)", () => {
    const station = createTestStation();
    const first = recordSyncEvent(station.id, { clientEventId: "evt-1", eventType: "transaction_completed", payload: { foo: 1 } });
    expect(first.status).toBe("stored");
    const retry = recordSyncEvent(station.id, { clientEventId: "evt-1", eventType: "transaction_completed", payload: { foo: 1 } });
    expect(retry.status).toBe("duplicate");

    const rows = db.prepare("SELECT COUNT(*) as c FROM station_sync_events WHERE station_id = ?").get(station.id) as { c: number };
    expect(rows.c).toBe(1);

    expect(getSyncState(station.id)?.last_synced_at).not.toBeNull();
  });

  it("farkli istasyonlar ayni client_event_id'yi bagimsiz olarak kullanabilir", () => {
    const stationA = createTestStation();
    const stationB = createTestStation();
    expect(recordSyncEvent(stationA.id, { clientEventId: "shared-id", eventType: "heartbeat" }).status).toBe("stored");
    expect(recordSyncEvent(stationB.id, { clientEventId: "shared-id", eventType: "heartbeat" }).status).toBe("stored");
  });

  it("ajanin bildirdigi gercek yazici arizasi (printer_fault) kritik bir alarm olusturur", () => {
    const station = createTestStation();
    recordSyncEvent(station.id, {
      clientEventId: "print-evt-1",
      eventType: "printer_fault",
      payload: { transactionId: 42, faultCode: "PAPER_OUT" },
    });
    const alarms = listAlarms(station.id, "active");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.type).toBe("printer_fault");
    expect(alarms[0]!.severity).toBe("critical");
    expect(alarms[0]!.message).toContain("PAPER_OUT");
    expect(alarms[0]!.message).toContain("#42");
  });

  it("ajanin bildirdigi gercek ÖKC arizasi (okc_fault) kritik bir alarm olusturur", () => {
    const station = createTestStation();
    recordSyncEvent(station.id, {
      clientEventId: "okc-evt-1",
      eventType: "okc_fault",
      payload: { transactionId: 7, faultCode: "OFFLINE" },
    });
    const alarms = listAlarms(station.id, "active");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.type).toBe("okc_fault");
    expect(alarms[0]!.severity).toBe("critical");
    expect(alarms[0]!.message).toContain("OFFLINE");
    expect(alarms[0]!.message).toContain("#7");
  });

  it("basarili senkron olaylari (printer_fault olmayan) hicbir alarm olusturmaz", () => {
    const station = createTestStation();
    recordSyncEvent(station.id, { clientEventId: "evt-ok", eventType: "transaction_completed", payload: {} });
    expect(listAlarms(station.id, "active")).toHaveLength(0);
  });
});

describe("syncService - istasyon onbellek anlik goruntusu", () => {
  it("pompa ve yakit fiyati bilgisini icerir", () => {
    const station = createTestStation();
    createTestPump(station.id);
    const snapshot = getStationCacheSnapshot(station.id);
    expect(snapshot.pumps).toHaveLength(1);
    expect(Array.isArray(snapshot.fuelPrices)).toBe(true);
    expect(Array.isArray(snapshot.fleetAccounts)).toBe(true);
  });
});

describe("syncService - cevrimdisi istasyon alarmi", () => {
  it("hic senkron olmamis bir istasyonu atlar (ajan henuz kurulmamis olabilir)", () => {
    const station = createTestStation();
    checkOfflineStations();
    expect(listAlarms(station.id).some((a) => a.type === "station_offline")).toBe(false);
  });

  it("son heartbeat'i esigi asan bir istasyon icin alarm uretir, tekrar calistirmak ikinci bir alarm uretmez", () => {
    const station = createTestStation();
    recordHeartbeat(station.id);
    const staleTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare("UPDATE station_sync_state SET last_heartbeat_at = ? WHERE station_id = ?").run(staleTimestamp, station.id);

    checkOfflineStations();
    const alarmsAfterFirst = listAlarms(station.id).filter((a) => a.type === "station_offline");
    expect(alarmsAfterFirst).toHaveLength(1);

    checkOfflineStations();
    const alarmsAfterSecond = listAlarms(station.id).filter((a) => a.type === "station_offline");
    expect(alarmsAfterSecond).toHaveLength(1);
  });

  it("yeni bir heartbeat gelince aktif cevrimdisi alarmini otomatik cozer", () => {
    const station = createTestStation();
    recordHeartbeat(station.id);
    const staleTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare("UPDATE station_sync_state SET last_heartbeat_at = ? WHERE station_id = ?").run(staleTimestamp, station.id);
    checkOfflineStations();
    expect(listAlarms(station.id, "active").some((a) => a.type === "station_offline")).toBe(true);

    recordHeartbeat(station.id);
    expect(listAlarms(station.id, "active").some((a) => a.type === "station_offline")).toBe(false);
  });
});
