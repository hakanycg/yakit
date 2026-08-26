import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { AlarmRow } from "../db/types.js";
import { createTestStation } from "../test/dbFixture.js";
import {
  evaluateErrorRate,
  getSystemErrorHealth,
  listSystemErrors,
  pruneSystemErrors,
  recordSystemError,
} from "./systemErrorService.js";

/**
 * Bu izleme yolunun kendisi sessizce bozulursa, bozuldugunu haber verecek bir sey
 * kalmaz - o yuzden davranisinin testle sabitlenmesi ayrica onemli.
 */

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

function insertErrorAt(minutesAgo: number, message = "Error: patladi"): void {
  db.prepare("INSERT INTO system_errors (kind, path, message, created_at) VALUES ('request', '/api/test', ?, ?)").run(
    message,
    new Date(NOW - minutesAgo * 60_000).toISOString()
  );
}

function systemAlarms(): AlarmRow[] {
  return db.prepare<[], AlarmRow>("SELECT * FROM alarms WHERE type = 'system_error_rate' ORDER BY id").all();
}

function openSystemAlarms(): AlarmRow[] {
  return systemAlarms().filter((a) => a.status !== "resolved");
}

beforeEach(() => {
  db.prepare("DELETE FROM system_errors").run();
  db.prepare("DELETE FROM alarms WHERE type = 'system_error_rate'").run();
  // Doner deger kullanilmaz ama CAGRI sart: alarm bir istasyona yazilir ve
  // platformStationId() en dusuk id'li AKTIF istasyonu arar - hic istasyon yoksa
  // alarm uretilemez ve testler sessizce anlamsizlasirdi.
  createTestStation();
});

describe("hata kaydi", () => {
  it("istek hatasi yolu ve mesajiyla kaydedilir", () => {
    recordSystemError({ kind: "request", path: "/api/kiosk/transactions", error: new Error("baglanti koptu") });

    const last = listSystemErrors(1)[0]!;
    expect(last.kind).toBe("request");
    expect(last.path).toBe("/api/kiosk/transactions");
    expect(last.message).toContain("baglanti koptu");
  });

  it("Error olmayan bir sey firlatildiginda da kaydedilir", () => {
    recordSystemError({ kind: "unhandled_rejection", error: "duz metin red" });
    expect(listSystemErrors(1)[0]!.message).toContain("duz metin red");
  });

  it("cok uzun mesaj kirpilir - tek bir yigin izi tabloyu sisirmesin", () => {
    recordSystemError({ kind: "request", error: new Error("x".repeat(5000)) });
    expect(listSystemErrors(1)[0]!.message.length).toBeLessThanOrEqual(500);
  });

  it("KAYIT ASLA HATA FIRLATMAZ - izleme yolu kesinti sebebi olamaz", () => {
    // Cagrildigi yer zaten hata isleme yolu: buradan cikan bir istisna errorHandler'a
    // geri doner, o yine buraya gelir ve sunucu sonsuz donguye girer.
    expect(() => recordSystemError({ kind: "request", error: { toString: () => { throw new Error("kotu nesne"); } } })).not.toThrow();
  });
});

describe("esik ve alarm", () => {
  it("esigin altinda alarm uretilmez", () => {
    for (let i = 0; i < 4; i += 1) insertErrorAt(1);
    evaluateErrorRate(NOW);
    expect(openSystemAlarms()).toHaveLength(0);
  });

  it("esik asilinca KRITIK alarm uretilir", () => {
    for (let i = 0; i < 5; i += 1) insertErrorAt(1);
    evaluateErrorRate(NOW);

    const alarm = openSystemAlarms()[0]!;
    expect(alarm.severity).toBe("critical");
    expect(alarm.message).toContain("SISTEM GENELI");
    expect(alarm.message).toContain("5 islenmeyen sunucu hatasi");
  });

  it("alarm mesaji son hatayi ve ucu ornek olarak tasir", () => {
    for (let i = 0; i < 5; i += 1) insertErrorAt(2);
    insertErrorAt(1, "Error: filo tahsilati basarisiz");
    evaluateErrorRate(NOW);

    // Personel loglara bakmadan once neye bakacagini bilmeli.
    expect(openSystemAlarms()[0]!.message).toContain("filo tahsilati basarisiz");
    expect(openSystemAlarms()[0]!.message).toContain("/api/test");
  });

  it("penceresi gecmis hatalar sayilmaz", () => {
    for (let i = 0; i < 10; i += 1) insertErrorAt(60); // 1 saat once
    evaluateErrorRate(NOW);
    expect(openSystemAlarms()).toHaveLength(0);
  });

  it("alarm acikken ust uste yeni alarm uretilmez", () => {
    for (let i = 0; i < 5; i += 1) insertErrorAt(1);
    evaluateErrorRate(NOW);
    for (let i = 0; i < 5; i += 1) insertErrorAt(1);
    evaluateErrorRate(NOW);

    // Her turda yeni alarm acmak alarm merkezini doldurur ve yukseltme mantigini bozar.
    expect(systemAlarms()).toHaveLength(1);
  });
});

describe("alarmin cozulmesi", () => {
  it("hata akisi tamamen durunca alarm cozulur", () => {
    for (let i = 0; i < 5; i += 1) insertErrorAt(1);
    evaluateErrorRate(NOW);
    expect(openSystemAlarms()).toHaveLength(1);

    // 45 dakika sonra, arada hic hata yok.
    evaluateErrorRate(NOW + 45 * 60_000);
    expect(openSystemAlarms()).toHaveLength(0);
  });

  it("sessizlik suresi dolmadan alarm cozulmez", () => {
    for (let i = 0; i < 5; i += 1) insertErrorAt(1);
    evaluateErrorRate(NOW);
    // 15 dakika sonra: pencere gecti ama sessizlik suresi (30 dk) dolmadi.
    evaluateErrorRate(NOW + 15 * 60_000);
    // Esigin hemen altina inen dalgali bir akis alarmi acip kapatip acmamali.
    expect(openSystemAlarms()).toHaveLength(1);
  });

  it("cozulduktan sonra yeniden hata gelirse tekrar uyarir", () => {
    for (let i = 0; i < 5; i += 1) insertErrorAt(1);
    evaluateErrorRate(NOW);
    evaluateErrorRate(NOW + 45 * 60_000);
    expect(openSystemAlarms()).toHaveLength(0);

    const later = NOW + 60 * 60_000;
    for (let i = 0; i < 5; i += 1) {
      db.prepare("INSERT INTO system_errors (kind, message, created_at) VALUES ('request', 'yine', ?)").run(
        new Date(later - 60_000).toISOString()
      );
    }
    evaluateErrorRate(later);
    expect(openSystemAlarms()).toHaveLength(1);
  });
});

describe("saglik ozeti ve budama", () => {
  it("saglik ozeti penceredeki sayiyi ve son hatayi bildirir", () => {
    insertErrorAt(120); // pencere disi
    insertErrorAt(2);
    insertErrorAt(1);

    const health = getSystemErrorHealth(NOW);
    expect(health.recentCount).toBe(2);
    expect(health.threshold).toBe(5);
    expect(health.windowMinutes).toBe(10);
    expect(health.lastErrorAt).not.toBeNull();
  });

  it("hic hata yokken ozet bos doner", () => {
    const health = getSystemErrorHealth(NOW);
    expect(health.recentCount).toBe(0);
    expect(health.lastErrorAt).toBeNull();
  });

  it("eski kayitlar budanir, yenileri kalir", () => {
    insertErrorAt(60 * 24 * 40); // 40 gun once
    insertErrorAt(1);

    expect(pruneSystemErrors(30 * 24 * 60 * 60 * 1000, NOW)).toBe(1);
    expect(listSystemErrors()).toHaveLength(1);
  });
});
