import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { StationRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { setWebhookConfig } from "./webhookSettingsService.js";
import { processWriteQueue } from "./writeQueueService.js";

const sendEmailMock = vi.fn((..._args: unknown[]) => Promise.resolve({ sent: true }));
const sendSmsMock = vi.fn((..._args: unknown[]) => Promise.resolve({ sent: true }));
const sendWebhookMock = vi.fn((..._args: unknown[]) => Promise.resolve({ sent: true }));

vi.mock("./notificationService.js", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  sendSms: (...args: unknown[]) => sendSmsMock(...args),
  sendWebhook: (...args: unknown[]) => sendWebhookMock(...args),
}));

const { createAlarm, listAlarmsPaged } = await import("./alarmService.js");

let station: StationRow;

beforeEach(() => {
  station = createTestStation();
  db.prepare("UPDATE stations SET name = 'Test Istasyonu' WHERE id = ?").run(station.id);
  sendEmailMock.mockClear();
  sendSmsMock.mockClear();
  sendWebhookMock.mockClear();
  // write_queue GLOBAL bir tablo (fileParallelism:false ile ayni SQLite dosyasini
  // paylasan baska dosyalar - ör. alarmEscalationService.test.ts - kendi kritik
  // alarmlarini kuyruga yazip hic bosaltmiyor). processWriteQueue() TUM bekleyen
  // kayitlari isler; bu testlerin sadece KENDI olusturduklarini gormesi icin
  // her testten once temizlenir.
  db.prepare("DELETE FROM write_queue").run();
});

/** createAlarm() bildirimi ANINDA gondermez, dayanikli kuyruga yazar (bkz. alarmService.ts) - gercekten
 * gonderilmesi icin kuyrugun bosaltilmasi (processWriteQueue) gerekir. */
async function createCriticalAndDrain(message = "test alarmi"): Promise<void> {
  createAlarm({ stationId: station.id, type: "short_delivery", severity: "critical", message });
  await processWriteQueue();
}

describe("createAlarm - webhook bildirimi", () => {
  it("webhook yapilandirilmamissa hic cagrilmaz, e-posta/SMS davranisi degismez", async () => {
    await createCriticalAndDrain();
    expect(sendWebhookMock).not.toHaveBeenCalled();
  });

  it("webhook etkinse e-posta/SMS'e EK olarak (yerine degil) cagrilir", async () => {
    const actor = createTestUser(station.id, "admin");
    setWebhookConfig(station.id, { enabled: true, url: "https://ops.example.com/hook" }, actor);

    await createCriticalAndDrain("pompa ariza verdi");

    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    const [url, payload, secret] = sendWebhookMock.mock.calls[0]!;
    expect(url).toBe("https://ops.example.com/hook");
    expect(secret).toBeNull();
    expect(payload).toMatchObject({
      event: "critical_alarm",
      stationId: station.id,
      stationName: "Test Istasyonu",
      type: "short_delivery",
      severity: "critical",
      message: "pompa ariza verdi",
    });
  });

  it("webhook kapaliyken (enabled:false) cagrilmaz, URL kayitli olsa bile", async () => {
    const actor = createTestUser(station.id, "admin");
    setWebhookConfig(station.id, { enabled: true, url: "https://ops.example.com/hook" }, actor);
    setWebhookConfig(station.id, { enabled: false }, actor);

    await createCriticalAndDrain();

    expect(sendWebhookMock).not.toHaveBeenCalled();
  });

  it("secret tanimliysa sendWebhook'a iletilir (imzalama notificationService.ts'in isi)", async () => {
    const actor = createTestUser(station.id, "admin");
    setWebhookConfig(station.id, { enabled: true, url: "https://ops.example.com/hook", secret: "cok-gizli-anahtar" }, actor);

    await createCriticalAndDrain();

    const [, , secret] = sendWebhookMock.mock.calls[0]!;
    expect(secret).toBe("cok-gizli-anahtar");
  });

  it("kritik olmayan alarmda ne e-posta/SMS ne webhook cagrilir", async () => {
    const actor = createTestUser(station.id, "admin");
    setWebhookConfig(station.id, { enabled: true, url: "https://ops.example.com/hook" }, actor);

    createAlarm({ stationId: station.id, type: "pump_fault", severity: "warning", message: "onemsiz" });
    await processWriteQueue();

    expect(sendWebhookMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("listAlarmsPaged", () => {
  function setCreatedAt(alarmId: number, isoDate: string): void {
    db.prepare("UPDATE alarms SET created_at = ? WHERE id = ?").run(isoDate, alarmId);
  }

  it("hicbir filtre verilmezse istasyonun tum alarmlarini en yeniden eskiye siralar", async () => {
    const a1 = createAlarm({ stationId: station.id, type: "pump_fault", severity: "warning", message: "m1" });
    setCreatedAt(a1.id, "2026-01-01T00:00:00.000Z");
    const a2 = createAlarm({ stationId: station.id, type: "pump_fault", severity: "warning", message: "m2" });
    setCreatedAt(a2.id, "2026-01-02T00:00:00.000Z");

    const result = listAlarmsPaged(station.id);
    expect(result.total).toBe(2);
    expect(result.alarms.map((a) => a.id)).toEqual([a2.id, a1.id]);
  });

  it("baska bir istasyonun alarmlarini GORMEZ", async () => {
    const other = createTestStation();
    createAlarm({ stationId: other.id, type: "pump_fault", severity: "warning", message: "baska istasyon" });

    const result = listAlarmsPaged(station.id);
    expect(result.total).toBe(0);
  });

  it("severity filtresi dogru uygulanir", async () => {
    createAlarm({ stationId: station.id, type: "pump_fault", severity: "warning", message: "uyari" });
    createAlarm({ stationId: station.id, type: "sensor", severity: "critical", message: "kritik" });

    const result = listAlarmsPaged(station.id, { severity: "critical" });
    expect(result.total).toBe(1);
    expect(result.alarms[0]!.severity).toBe("critical");
  });

  it("type filtresi TAM eslesme arar", async () => {
    createAlarm({ stationId: station.id, type: "pump_fault", severity: "warning", message: "m1" });
    createAlarm({ stationId: station.id, type: "sensor", severity: "warning", message: "m2" });

    const result = listAlarmsPaged(station.id, { type: "sensor" });
    expect(result.total).toBe(1);
    expect(result.alarms[0]!.type).toBe("sensor");
  });

  it("pumpId filtresi dogru uygulanir", async () => {
    const insertPump = db.prepare(
      "INSERT INTO pumps (station_id, number, label, fuel_types) VALUES (?, ?, ?, '[\"benzin\"]')"
    );
    const pump1 = insertPump.run(station.id, 1, "Pompa 1").lastInsertRowid as number;
    const pump2 = insertPump.run(station.id, 2, "Pompa 2").lastInsertRowid as number;
    createAlarm({ stationId: station.id, pumpId: pump1, type: "pump_fault", severity: "warning", message: "pompa 1" });
    createAlarm({ stationId: station.id, pumpId: pump2, type: "pump_fault", severity: "warning", message: "pompa 2" });

    const result = listAlarmsPaged(station.id, { pumpId: pump2 });
    expect(result.total).toBe(1);
    expect(result.alarms[0]!.pump_id).toBe(pump2);
  });

  it("tarih araligi (from/to) dogru filtreler - 'to' gunun sonuna kadar dahil eder", async () => {
    const old = createAlarm({ stationId: station.id, type: "pump_fault", severity: "warning", message: "eski" });
    setCreatedAt(old.id, "2025-01-01T00:00:00.000Z");
    const inRange = createAlarm({ stationId: station.id, type: "pump_fault", severity: "warning", message: "aralikta" });
    setCreatedAt(inRange.id, "2026-01-15T23:59:00.000Z");
    const future = createAlarm({ stationId: station.id, type: "pump_fault", severity: "warning", message: "gelecek" });
    setCreatedAt(future.id, "2026-02-01T00:00:00.000Z");

    const result = listAlarmsPaged(station.id, { from: "2026-01-01", to: "2026-01-15" });
    expect(result.alarms.map((a) => a.id)).toEqual([inRange.id]);
  });

  it("sayfalama: page/pageSize dogru satirlari doner, total TUM eslesenleri sayar (sayfadaki degil)", async () => {
    for (let i = 0; i < 5; i++) {
      const a = createAlarm({ stationId: station.id, type: "pump_fault", severity: "warning", message: `m${i}` });
      setCreatedAt(a.id, new Date(2026, 0, i + 1).toISOString());
    }

    const firstPage = listAlarmsPaged(station.id, { pageSize: 2, page: 1 });
    expect(firstPage.total).toBe(5);
    expect(firstPage.alarms).toHaveLength(2);

    const secondPage = listAlarmsPaged(station.id, { pageSize: 2, page: 2 });
    expect(secondPage.alarms).toHaveLength(2);
    expect(secondPage.alarms[0]!.id).not.toBe(firstPage.alarms[0]!.id);

    const thirdPage = listAlarmsPaged(station.id, { pageSize: 2, page: 3 });
    expect(thirdPage.alarms).toHaveLength(1);
  });

  it("pageSize 100'u asamaz, page 1'in altina inemez", async () => {
    createAlarm({ stationId: station.id, type: "pump_fault", severity: "warning", message: "m" });

    const result = listAlarmsPaged(station.id, { pageSize: 500, page: -3 });
    expect(result.pageSize).toBe(100);
    expect(result.page).toBe(1);
  });
});
