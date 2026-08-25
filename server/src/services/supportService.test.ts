import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { AlarmRow, StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestTransaction, createTestUser } from "../test/dbFixture.js";
import {
  countOpenSupportRequests,
  createSupportRequest,
  listSupportRequests,
  resolveSupportRequest,
} from "./supportService.js";

let station: StationRow;
let pumpId: number;
let actor: UserRow;

function alarmsFor(stationId: number): AlarmRow[] {
  return db
    .prepare<[number], AlarmRow>(
      "SELECT * FROM alarms WHERE station_id = ? AND type = 'customer_support_request' ORDER BY id ASC"
    )
    .all(stationId);
}

const MINUTE = 60_000;

beforeEach(() => {
  station = createTestStation();
  pumpId = createTestPump(station.id);
  actor = createTestUser(station.id, "operator");
});

describe("createSupportRequest", () => {
  it("talebi kaydeder ve kritik alarma cevirir", () => {
    const { request, alarmRaised } = createSupportRequest({
      stationId: station.id,
      category: "dispenser",
      message: "Kartimdan para cekildi ama yakit akmadi",
      pumpId,
    });

    expect(alarmRaised).toBe(true);
    const alarms = alarmsFor(station.id);
    expect(alarms).toHaveLength(1);
    // Kritik siddet bilincli: mevcut kritik alarm bildirim zinciri (e-posta/SMS)
    // hicbir ek is yapilmadan devreye girsin diye.
    expect(alarms[0]!.severity).toBe("critical");
    expect(alarms[0]!.pump_id).toBe(pumpId);
    expect(request.alarm_id).toBe(alarms[0]!.id);
  });

  it("alarm mesajina pompa, islem ve musteri notunu koyar", () => {
    const txId = createTestTransaction(station.id, pumpId);
    createSupportRequest({
      stationId: station.id,
      category: "payment",
      message: "Kart okumuyor",
      contactPhone: "05551112233",
      pumpId,
      transactionId: txId,
    });

    const msg = alarmsFor(station.id)[0]!.message;
    expect(msg).toContain("Odeme sorunu");
    expect(msg).toContain("Pompa");
    expect(msg).toContain(`islem #${txId}`);
    expect(msg).toContain("Kart okumuyor");
    expect(msg).toContain("05551112233");
  });

  it("ayni kiosk'tan kisa surede gelen tekrarli talepler icin yeni alarm uretmez", () => {
    // Panige kapilan bir musteri butona ust uste basabilir; her basis nobetci
    // personele ayri bir SMS gonderirse bildirim zinciri ise yaramaz hale gelir.
    const kioskId = db
      .prepare("INSERT INTO station_kiosks (station_id, label, device_token) VALUES (?, 'Ada 1', ?)")
      .run(station.id, `tok-${Math.random()}`).lastInsertRowid as number;

    const first = createSupportRequest({ stationId: station.id, kioskId, category: "other" });
    const second = createSupportRequest({ stationId: station.id, kioskId, category: "other" });
    const third = createSupportRequest({ stationId: station.id, kioskId, category: "dispenser" });

    expect(first.alarmRaised).toBe(true);
    expect(second.alarmRaised).toBe(false);
    expect(third.alarmRaised).toBe(false);
    // Talepler yine de KAYDEDILIR - yalnizca alarm tekrarlanmaz.
    expect(listSupportRequests(station.id, "open")).toHaveLength(3);
    expect(alarmsFor(station.id)).toHaveLength(1);
  });

  it("susturma penceresi gecince yeniden alarm uretir", () => {
    const kioskId = db
      .prepare("INSERT INTO station_kiosks (station_id, label, device_token) VALUES (?, 'Ada 1', ?)")
      .run(station.id, `tok-${Math.random()}`).lastInsertRowid as number;
    const t0 = Date.now();

    createSupportRequest({ stationId: station.id, kioskId, category: "other" }, t0);
    const later = createSupportRequest({ stationId: station.id, kioskId, category: "other" }, t0 + 11 * MINUTE);

    expect(later.alarmRaised).toBe(true);
    expect(alarmsFor(station.id)).toHaveLength(2);
  });

  it("farkli kiosk'lar birbirinin alarmini susturmaz", () => {
    const mk = (label: string) =>
      db
        .prepare("INSERT INTO station_kiosks (station_id, label, device_token) VALUES (?, ?, ?)")
        .run(station.id, label, `tok-${Math.random()}`).lastInsertRowid as number;

    createSupportRequest({ stationId: station.id, kioskId: mk("Ada 1"), category: "other" });
    const other = createSupportRequest({ stationId: station.id, kioskId: mk("Ada 2"), category: "other" });

    expect(other.alarmRaised).toBe(true);
    expect(alarmsFor(station.id)).toHaveLength(2);
  });

  it("baska istasyonun pompasiyla talep acilmasini engeller", () => {
    const other = createTestStation();
    const otherPump = createTestPump(other.id);

    expect(() =>
      createSupportRequest({ stationId: station.id, category: "dispenser", pumpId: otherPump })
    ).toThrow(/bu istasyona ait degil/i);
  });

  it("baska istasyonun islemiyle talep acilmasini engeller", () => {
    const other = createTestStation();
    const otherTx = createTestTransaction(other.id, createTestPump(other.id));

    expect(() =>
      createSupportRequest({ stationId: station.id, category: "payment", transactionId: otherTx })
    ).toThrow(/bu istasyona ait degil/i);
  });
});

describe("resolveSupportRequest", () => {
  it("talebi kapatir ve bagli alarmi da cozer", () => {
    // Ikisi ayri kalirsa alarm merkezi kapatilmis taleplerin alarmlariyla kirli birikir.
    const { request } = createSupportRequest({ stationId: station.id, category: "dispenser" });

    const resolved = resolveSupportRequest(request.id, station.id, "Pompa yeniden baslatildi", actor);

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution_note).toBe("Pompa yeniden baslatildi");
    expect(alarmsFor(station.id)[0]!.status).toBe("resolved");
  });

  it("ayni talebi iki kez kapatmayi reddeder", () => {
    const { request } = createSupportRequest({ stationId: station.id, category: "other" });
    resolveSupportRequest(request.id, station.id, null, actor);

    expect(() => resolveSupportRequest(request.id, station.id, null, actor)).toThrow(/zaten kapatilmis/);
  });

  it("baska istasyonun talebini kapatmayi reddeder", () => {
    const other = createTestStation();
    const { request } = createSupportRequest({ stationId: station.id, category: "other" });

    expect(() => resolveSupportRequest(request.id, other.id, null, actor)).toThrow(/bulunamadi/);
  });
});

describe("listSupportRequests / countOpenSupportRequests", () => {
  it("duruma gore filtreler ve acik sayisini verir", () => {
    const a = createSupportRequest({ stationId: station.id, category: "payment" });
    createSupportRequest({ stationId: station.id, category: "dispenser" });
    resolveSupportRequest(a.request.id, station.id, null, actor);

    expect(countOpenSupportRequests(station.id)).toBe(1);
    expect(listSupportRequests(station.id, "open")).toHaveLength(1);
    expect(listSupportRequests(station.id, "resolved")).toHaveLength(1);
    expect(listSupportRequests(station.id)).toHaveLength(2);
  });

  it("baska istasyonun taleplerini karistirmaz", () => {
    const other = createTestStation();
    createSupportRequest({ stationId: station.id, category: "other" });

    expect(countOpenSupportRequests(other.id)).toBe(0);
    expect(listSupportRequests(other.id)).toHaveLength(0);
  });
});
