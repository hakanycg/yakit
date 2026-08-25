import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { createAccount, addPlate } from "./fleetService.js";
import {
  DataRetentionError,
  getRetentionSettings,
  previewRetention,
  sweepDataRetention,
  sweepStation,
  updateRetentionSettings,
} from "./dataRetentionService.js";

let station: StationRow;
let actor: UserRow;
const ANON = "[SILINDI]";

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString();
}

function addTransaction(opts: { plate: string; at: string; email?: string; phone?: string }): number {
  const pumpId = createTestPump(station.id);
  return db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
          total_amount, payment_status, status, kiosk_access_token, receipt_email, receipt_phone, created_at, completed_at)
       VALUES (?, ?, ?, 'motorin', 'amount', 50, 10, 500, 'captured', 'completed', ?, ?, ?, ?, ?)`
    )
    .run(station.id, pumpId, opts.plate, `tok-${Math.random()}`, opts.email ?? null, opts.phone ?? null, opts.at, opts.at)
    .lastInsertRowid as number;
}

function tx(id: number) {
  return db
    .prepare<[number], { plate: string; receipt_email: string | null; receipt_phone: string | null; total_amount: number }>(
      "SELECT plate, receipt_email, receipt_phone, total_amount FROM transactions WHERE id = ?"
    )
    .get(id)!;
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  updateRetentionSettings(station.id, { enabled: true, retentionMonths: 24 }, actor);
});

describe("ayarlar", () => {
  it("varsayilan KAPALIDIR", () => {
    // Kisisel veriyi geri donulemez sekilde silen bir surec, istasyon kendi politikasini
    // belirlemeden kendiliginden calismaya baslamamali.
    const fresh = createTestStation();
    expect(getRetentionSettings(fresh.id).enabled).toBe(false);
  });

  it("varsayilan sure 24 ay", () => {
    expect(getRetentionSettings(createTestStation().id).retentionMonths).toBe(24);
  });

  it("cok kisa sureyi reddeder", () => {
    // Yanlislikla girilen bir "1", geri donulemez bir veri kaybi olurdu.
    expect(() => updateRetentionSettings(station.id, { retentionMonths: 1 }, actor)).toThrow(DataRetentionError);
    expect(() => updateRetentionSettings(station.id, { retentionMonths: 500 }, actor)).toThrow(DataRetentionError);
  });

  it("kapaliyken tarama hicbir sey yapmaz", () => {
    updateRetentionSettings(station.id, { enabled: false }, actor);
    const id = addTransaction({ plate: "34ABC01", at: monthsAgo(40) });

    expect(sweepStation(station.id)).toBeNull();
    expect(tx(id).plate).toBe("34ABC01");
  });
});

describe("islem anonimlestirme", () => {
  it("penceredeki ESKI islemin kisisel alanlarini temizler", () => {
    const id = addTransaction({ plate: "34ABC01", at: monthsAgo(30), email: "a@b.com", phone: "05551112233" });

    sweepStation(station.id);

    const row = tx(id);
    expect(row.plate).toBe(ANON);
    expect(row.receipt_email).toBeNull();
    expect(row.receipt_phone).toBeNull();
  });

  it("MALI KAYDI korur - parayi tut, kimligi dusur", () => {
    // VUK/TTK mali kaydin saklanmasini zorunlu kilar; KVKK kimligin silinmesini ister.
    // Ikisi celismez cunku istedikleri sey ayni sey degildir.
    const id = addTransaction({ plate: "34ABC01", at: monthsAgo(30) });

    sweepStation(station.id);

    expect(tx(id).total_amount).toBe(500);
  });

  it("pencere ICINDEKI islemi degistirmez", () => {
    const id = addTransaction({ plate: "34ABC01", at: monthsAgo(3), email: "a@b.com" });

    sweepStation(station.id);

    expect(tx(id).plate).toBe("34ABC01");
    expect(tx(id).receipt_email).toBe("a@b.com");
  });

  it("FILO plakasina dokunmaz", () => {
    // Aktif bir ticari sozlesmeye bagli; isleme amaci hala devam ediyor.
    const accountId = createAccount(station.id, { companyName: "Filo A.S.", billingType: "prepaid" }, actor).id;
    addPlate(station.id, accountId, "34FLO01");
    const id = addTransaction({ plate: "34FLO01", at: monthsAgo(40) });

    sweepStation(station.id);

    expect(tx(id).plate).toBe("34FLO01");
  });

  it("baska istasyonun islemine dokunmaz", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    updateRetentionSettings(other.id, { enabled: true, retentionMonths: 24 }, otherActor);
    const id = addTransaction({ plate: "34ABC01", at: monthsAgo(40) });

    sweepStation(other.id);

    expect(tx(id).plate).toBe("34ABC01");
  });

  it("tekrar calistirildiginda ayni satirlari yeniden saymaz", () => {
    addTransaction({ plate: "34ABC01", at: monthsAgo(30) });

    const first = sweepStation(station.id)!;
    const second = sweepStation(station.id)!;

    expect(first.transactionsAnonymized).toBe(1);
    expect(second.transactionsAnonymized).toBe(0);
  });
});

describe("sadakat verisi", () => {
  it("eski sadakat hareketinin plakasini anonimlestirir", () => {
    db.prepare(
      "INSERT INTO loyalty_movements (station_id, plate, type, points, balance_after, created_at) VALUES (?, '34ABC01', 'earn', 10, 10, ?)"
    ).run(station.id, monthsAgo(30));

    sweepStation(station.id);

    expect(
      db.prepare<[number], { plate: string }>("SELECT plate FROM loyalty_movements WHERE station_id = ?").get(station.id)!.plate
    ).toBe(ANON);
  });

  it("ATIL sadakat hesabini siler", () => {
    // Kullanilmayan bir hesabin plakasini tutmak, amaci kalmamis kisisel veri saklamaktir.
    db.prepare("INSERT INTO loyalty_accounts (station_id, plate, points, updated_at) VALUES (?, '34ESKI1', 120, ?)").run(
      station.id,
      monthsAgo(30)
    );

    const result = sweepStation(station.id)!;

    expect(result.dormantLoyaltyAccountsDeleted).toBe(1);
    expect(
      db.prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM loyalty_accounts WHERE station_id = ?").get(station.id)!.c
    ).toBe(0);
  });

  it("son donemde hareketi olan hesaba dokunmaz", () => {
    // Musteri hala programin icinde.
    db.prepare("INSERT INTO loyalty_accounts (station_id, plate, points, updated_at) VALUES (?, '34AKTIF', 50, ?)").run(
      station.id,
      monthsAgo(30)
    );
    db.prepare(
      "INSERT INTO loyalty_movements (station_id, plate, type, points, balance_after, created_at) VALUES (?, '34AKTIF', 'earn', 5, 55, ?)"
    ).run(station.id, monthsAgo(2));

    sweepStation(station.id);

    expect(
      db.prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM loyalty_accounts WHERE station_id = ? AND plate = '34AKTIF'").get(station.id)!.c
    ).toBe(1);
  });

  it("guncel sadakat hesabina dokunmaz", () => {
    db.prepare("INSERT INTO loyalty_accounts (station_id, plate, points, updated_at) VALUES (?, '34YENI1', 10, ?)").run(
      station.id,
      monthsAgo(1)
    );

    expect(sweepStation(station.id)!.dormantLoyaltyAccountsDeleted).toBe(0);
  });
});

describe("onizleme", () => {
  it("etkilenecek kayit sayisini once gosterir", () => {
    // Geri donulemez bir islemi once gostermeden calistirmak dogru olmaz.
    addTransaction({ plate: "34ABC01", at: monthsAgo(30) });
    addTransaction({ plate: "34ABC02", at: monthsAgo(3) });

    const preview = previewRetention(station.id);

    expect(preview.transactions).toBe(1);
    expect(preview.cutoff < new Date().toISOString()).toBe(true);
  });

  it("ayar kapali olsa da onizleme calisir", () => {
    updateRetentionSettings(station.id, { enabled: false }, actor);
    addTransaction({ plate: "34ABC01", at: monthsAgo(30) });

    expect(previewRetention(station.id).transactions).toBe(1);
  });
});

describe("tum istasyonlar taramasi", () => {
  it("yalnizca acik olan istasyonlari isler", () => {
    const off = createTestStation();
    const results = sweepDataRetention();

    expect(results.some((r) => r.stationId === station.id)).toBe(true);
    expect(results.some((r) => r.stationId === off.id)).toBe(false);
  });

  it("yapilan imhayi denetim izine yazar", () => {
    // KVKK uyumu "yapiyoruz" demek degil, yaptigini GOSTEREBILMEKTIR.
    addTransaction({ plate: "34ABC01", at: monthsAgo(30) });

    sweepDataRetention();

    expect(
      db
        .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'kvkk_retention_applied' AND station_id = ?")
        .get(station.id)!.c
    ).toBeGreaterThan(0);
  });

  it("silinecek bir sey yoksa denetim kaydi yazmaz", () => {
    // Her turda bos bir kayit yazmak denetim izini kullanilamaz hale getirirdi.
    const quiet = createTestStation();
    const quietActor = createTestUser(quiet.id, "admin");
    updateRetentionSettings(quiet.id, { enabled: true }, quietActor);

    sweepDataRetention();

    expect(
      db
        .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'kvkk_retention_applied' AND station_id = ?")
        .get(quiet.id)!.c
    ).toBe(0);
  });
});
