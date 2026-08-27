import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { AlarmRow, StationRow } from "../db/types.js";
import { createTestStation, createTestTenant, createTestUser } from "../test/dbFixture.js";
import { createAlarm } from "./alarmService.js";
import { setWebhookConfig } from "./webhookSettingsService.js";
import { processWriteQueue } from "./writeQueueService.js";
import {
  AlarmEscalationError,
  nextLevelFor,
  recipientsForLevel,
  sweepAlarmEscalations,
  thresholdsFor,
  updateEscalationSettings,
} from "./alarmEscalationService.js";

const sendEmailMock = vi.fn((..._args: unknown[]) => Promise.resolve({ sent: true }));
const sendSmsMock = vi.fn((..._args: unknown[]) => Promise.resolve({ sent: true }));
const sendWebhookMock = vi.fn((..._args: unknown[]) => Promise.resolve({ sent: true }));

vi.mock("./notificationService.js", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  sendSms: (...args: unknown[]) => sendSmsMock(...args),
  sendWebhook: (...args: unknown[]) => sendWebhookMock(...args),
}));

let station: StationRow;
let actor: ReturnType<typeof createTestUser>;
const MIN = 60_000;

function makeAlarm(opts: { type?: string; severity?: "info" | "warning" | "critical"; ageMinutes?: number } = {}): AlarmRow {
  const alarm = createAlarm({
    stationId: station.id,
    type: opts.type ?? "short_delivery",
    severity: opts.severity ?? "critical",
    message: "test alarmi",
  });
  if (opts.ageMinutes) {
    db.prepare("UPDATE alarms SET created_at = ? WHERE id = ?").run(
      new Date(Date.now() - opts.ageMinutes * MIN).toISOString(),
      alarm.id
    );
  }
  return db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(alarm.id)!;
}

function reload(id: number): AlarmRow {
  return db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(id)!;
}

function queuedEscalations(): number {
  return db
    .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM write_queue WHERE kind = 'alarm_escalation_notification'")
    .get()!.c;
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  sendEmailMock.mockClear();
  sendSmsMock.mockClear();
  sendWebhookMock.mockClear();
  // write_queue GLOBAL bir tablo (fileParallelism:false) - bu dosyanin kendi
  // testlerinin processWriteQueue() ile sadece KENDI kuyruga yazdiklarini
  // gormesi icin her testten once temizlenir.
  db.prepare("DELETE FROM write_queue").run();
});

describe("asama secimi", () => {
  it("esik dolmadan bir sey yapmaz", () => {
    const alarm = makeAlarm({ ageMinutes: 5 });
    expect(nextLevelFor(alarm, Date.now())).toBeNull();
  });

  it("hatirlatma esiginde 1. asamaya gecer", () => {
    expect(nextLevelFor(makeAlarm({ ageMinutes: 16 }), Date.now())).toBe(1);
  });

  it("yukseltme esiginde dogrudan 2. asamaya gecer", () => {
    // Alarm uzun sure fark edilmeden kalmissa (ör. sunucu kapaliydi) once hatirlatma
    // gonderip bir tur daha beklemek zaman kaybidir.
    expect(nextLevelFor(makeAlarm({ ageMinutes: 60 }), Date.now())).toBe(2);
  });

  it("kritik olmayan alarmi yukseltmez", () => {
    expect(nextLevelFor(makeAlarm({ severity: "warning", ageMinutes: 120 }), Date.now())).toBeNull();
  });

  it("ONAYLANAN alarmi yukseltmez", () => {
    // "acknowledged" bir insanin ilgilendigi anlamina gelir; sahada ariza gideren birini
    // aramaya devam etmek onu telefonu susturmaya iter.
    const alarm = makeAlarm({ ageMinutes: 60 });
    db.prepare("UPDATE alarms SET status = 'acknowledged' WHERE id = ?").run(alarm.id);

    expect(nextLevelFor(reload(alarm.id), Date.now())).toBeNull();
  });

  it("cozulen alarmi yukseltmez", () => {
    const alarm = makeAlarm({ ageMinutes: 60 });
    db.prepare("UPDATE alarms SET status = 'resolved' WHERE id = ?").run(alarm.id);

    expect(nextLevelFor(reload(alarm.id), Date.now())).toBeNull();
  });

  it("2. asamadan sonra durur", () => {
    // Sinirsiz tekrar, insanlarin kanali tamamen susturmasina yol acar.
    const alarm = makeAlarm({ ageMinutes: 600 });
    db.prepare("UPDATE alarms SET escalation_level = 2 WHERE id = ?").run(alarm.id);

    expect(nextLevelFor(reload(alarm.id), Date.now())).toBeNull();
  });

  it("sayac son bildirimden degil ALARMIN OLUSMASINDAN isler", () => {
    // Bildirim gecikmeli gonderilse bile yukseltme takvimi kaymamali.
    const alarm = makeAlarm({ ageMinutes: 60 });
    db.prepare("UPDATE alarms SET escalation_level = 1, last_notified_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      alarm.id
    );

    expect(nextLevelFor(reload(alarm.id), Date.now())).toBe(2);
  });
});

describe("guvenlik alarmlari", () => {
  it("yangin/gaz kaynakli acil durdurmada sure cok daha kisadir", () => {
    const safety = thresholdsFor({ station_id: station.id, type: "emergency_stop" });
    const standard = thresholdsFor({ station_id: station.id, type: "short_delivery" });

    expect(safety.reminderMinutes).toBe(3);
    expect(safety.escalateMinutes).toBe(10);
    expect(standard.reminderMinutes).toBeGreaterThan(safety.reminderMinutes);
  });

  it("guvenlik suresi istasyon ayariyla gevsetilemez", () => {
    // Bir yangin alarminin yukseltme saatini 6 saate cekmek isletmeye birakilabilecek
    // bir tercih degildir.
    updateEscalationSettings(station.id, { reminderMinutes: 360, escalateMinutes: 720 }, actor);

    expect(thresholdsFor({ station_id: station.id, type: "emergency_stop" }).reminderMinutes).toBe(3);
  });

  it("guvenlik alarmi 4 dakikada hatirlatmaya girer", () => {
    expect(nextLevelFor(makeAlarm({ type: "emergency_stop", ageMinutes: 4 }), Date.now())).toBe(1);
  });
});

describe("ayarlar", () => {
  it("istasyon bazinda degistirilebilir", () => {
    const s = updateEscalationSettings(station.id, { reminderMinutes: 5, escalateMinutes: 20 }, actor);

    expect(s.reminderMinutes).toBe(5);
    expect(nextLevelFor(makeAlarm({ ageMinutes: 6 }), Date.now())).toBe(1);
  });

  it("yukseltme suresi hatirlatmadan kisa olamaz", () => {
    // Aksi halde alarm dogrudan ust kademeye ziplar ve istasyonun kendi ekibine haber
    // verme sansi elinden alinir.
    expect(() => updateEscalationSettings(station.id, { reminderMinutes: 30, escalateMinutes: 10 }, actor)).toThrow(
      AlarmEscalationError
    );
  });

  it("gecersiz sureyi reddeder", () => {
    expect(() => updateEscalationSettings(station.id, { reminderMinutes: 0 }, actor)).toThrow(AlarmEscalationError);
    expect(() => updateEscalationSettings(station.id, { escalateMinutes: 5000 }, actor)).toThrow(AlarmEscalationError);
  });
});

describe("tarama", () => {
  it("bildirimi kuyruga yazar ve asamayi ilerletir", () => {
    const alarm = makeAlarm({ ageMinutes: 16 });
    const before = queuedEscalations();

    const result = sweepAlarmEscalations();

    expect(result.reminded).toBeGreaterThanOrEqual(1);
    expect(queuedEscalations()).toBeGreaterThan(before);
    expect(reload(alarm.id).escalation_level).toBe(1);
    expect(reload(alarm.id).last_notified_at).not.toBeNull();
  });

  it("ayni alarmi bir sonraki turda TEKRAR ele almaz", () => {
    const alarm = makeAlarm({ ageMinutes: 16 });
    sweepAlarmEscalations();
    const after = queuedEscalations();

    sweepAlarmEscalations();

    expect(queuedEscalations()).toBe(after);
    expect(reload(alarm.id).escalation_level).toBe(1);
  });

  it("sure ilerleyince 2. asamaya gecer", () => {
    const alarm = makeAlarm({ ageMinutes: 16 });
    sweepAlarmEscalations();

    db.prepare("UPDATE alarms SET created_at = ? WHERE id = ?").run(
      new Date(Date.now() - 60 * MIN).toISOString(),
      alarm.id
    );
    const result = sweepAlarmEscalations();

    expect(result.escalated).toBeGreaterThanOrEqual(1);
    expect(reload(alarm.id).escalation_level).toBe(2);
  });

  it("onaylanan alarm taramada atlanir", () => {
    const alarm = makeAlarm({ ageMinutes: 60 });
    db.prepare("UPDATE alarms SET status = 'acknowledged' WHERE id = ?").run(alarm.id);
    const before = queuedEscalations();

    sweepAlarmEscalations();

    expect(queuedEscalations()).toBe(before);
    expect(reload(alarm.id).escalation_level).toBe(0);
  });
});

describe("webhook bildirimi", () => {
  it("hatirlatma asamasinda 'critical_alarm_reminder' olayiyla cagirir", async () => {
    // Once ILK bildirimi (createAlarm'in kendi "critical_alarm" olayi) bosalt - webhook
    // henuz yapilandirilmadigi icin bu turda hicbir cagri yapilmaz; boylece asagidaki
    // sayim yalnizca HATIRLATMA olayini olcer.
    makeAlarm({ ageMinutes: 16 });
    await processWriteQueue();
    sendWebhookMock.mockClear();

    setWebhookConfig(station.id, { enabled: true, url: "https://ops.example.com/hook" }, actor);
    sweepAlarmEscalations();
    await processWriteQueue();

    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    const [, payload] = sendWebhookMock.mock.calls[0]!;
    expect(payload).toMatchObject({ event: "critical_alarm_reminder", stationId: station.id });
  });

  it("yukseltme asamasinda 'critical_alarm_escalated' olayiyla cagirir", async () => {
    makeAlarm({ ageMinutes: 60 });
    await processWriteQueue();
    sendWebhookMock.mockClear();

    setWebhookConfig(station.id, { enabled: true, url: "https://ops.example.com/hook" }, actor);
    sweepAlarmEscalations();
    await processWriteQueue();

    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    const [, payload] = sendWebhookMock.mock.calls[0]!;
    expect(payload).toMatchObject({ event: "critical_alarm_escalated", stationId: station.id });
  });

  it("webhook yapilandirilmamis istasyonda hicbir cagri yapilmaz", async () => {
    makeAlarm({ ageMinutes: 16 });

    sweepAlarmEscalations();
    await processWriteQueue();

    expect(sendWebhookMock).not.toHaveBeenCalled();
  });
});

describe("alici listesi", () => {
  it("yukseltmede dagitim sirketi yoneticisi de bilgilendirilir", () => {
    const tenant = createTestTenant();
    const tenantStation = createTestStation(tenant.id);
    const tenantAdmin = createTestUser(null, "tenant_admin", tenant.id);
    db.prepare("UPDATE users SET email = ?, notify_email = 1 WHERE id = ?").run("kiraci@ornek.com", tenantAdmin.id);

    const emails = recipientsForLevel({ station_id: tenantStation.id }, 2).map((r) => r.email);

    expect(emails).toContain("kiraci@ornek.com");
  });

  it("hatirlatma asamasinda ust kademe BILGILENDIRILMEZ", () => {
    // Yukseltmenin anlami, istasyonun kendi ekibine once sans verilmesidir.
    const tenant = createTestTenant();
    const tenantStation = createTestStation(tenant.id);
    const tenantAdmin = createTestUser(null, "tenant_admin", tenant.id);
    db.prepare("UPDATE users SET email = ?, notify_email = 1 WHERE id = ?").run("kiraci2@ornek.com", tenantAdmin.id);

    const emails = recipientsForLevel({ station_id: tenantStation.id }, 1).map((r) => r.email);

    expect(emails).not.toContain("kiraci2@ornek.com");
  });

  it("baska bir dagitim sirketinin yoneticisine haber verilmez", () => {
    const mine = createTestTenant();
    const other = createTestTenant();
    const myStation = createTestStation(mine.id);
    const otherAdmin = createTestUser(null, "tenant_admin", other.id);
    db.prepare("UPDATE users SET email = ?, notify_email = 1 WHERE id = ?").run("baska@ornek.com", otherAdmin.id);

    const emails = recipientsForLevel({ station_id: myStation.id }, 2).map((r) => r.email);

    expect(emails).not.toContain("baska@ornek.com");
  });

  it("yukseltmede istasyon ekibi listede KALIR", () => {
    // Haberi almayi biraktiklari icin degil, cevap veremedikleri icin yukseltiyoruz.
    const s2 = createTestStation();
    const operator = createTestUser(s2.id, "operator");
    db.prepare("UPDATE users SET email = ?, notify_email = 1 WHERE id = ?").run("operator@ornek.com", operator.id);

    expect(recipientsForLevel({ station_id: s2.id }, 2).map((r) => r.email)).toContain("operator@ornek.com");
  });
});
