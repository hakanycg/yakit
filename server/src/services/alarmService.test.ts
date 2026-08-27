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

const { createAlarm } = await import("./alarmService.js");

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
