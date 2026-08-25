import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import {
  closeDay,
  currentBusinessDate,
  getDaySummary,
  listReconciliations,
} from "./reconciliationService.js";

let station: StationRow;
let pumpId: number;
let actor: UserRow;

interface SaleInput {
  /** UTC zaman damgasi; is gunu bundan +3 saat kaydirilarak bulunur. */
  at: string;
  amount: number;
  discount?: number;
  method?: string;
  status?: string;
  paymentStatus?: string;
  liters?: number;
  fuelType?: string;
}

function addSale(input: SaleInput): number {
  const r = db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
          total_amount, discount_amount, payment_method, payment_status, status,
          kiosk_access_token, created_at, completed_at)
       VALUES (?, ?, '34ABC01', ?, 'amount', 45, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      station.id,
      pumpId,
      input.fuelType ?? "motorin",
      input.liters ?? 10,
      input.amount,
      input.discount ?? 0,
      input.method ?? "iyzico",
      input.paymentStatus ?? "captured",
      input.status ?? "completed",
      `tok-${Math.random().toString(16).slice(2)}`,
      input.at,
      input.at
    );
  return r.lastInsertRowid as number;
}

function addRefund(input: { transactionId: number; amount: number; at: string; status?: string }): void {
  db.prepare(
    `INSERT INTO refunds (station_id, transaction_id, amount, reason, payment_method, status, created_at)
     VALUES (?, ?, ?, 'Musteri talebi', 'iyzico', ?, ?)`
  ).run(station.id, input.transactionId, input.amount, input.status ?? "completed", input.at);
}

beforeEach(() => {
  station = createTestStation();
  pumpId = createTestPump(station.id);
  actor = createTestUser(station.id, "admin");
});

describe("is gunu siniri", () => {
  it("gece yarisindan sonraki satis, YEREL gunun kasasina yazilir", () => {
    // Turkiye UTC+3: 2026-08-10 01:30 yerel saat = 2026-08-09 22:30 UTC.
    // UTC tarihine gore gruplansaydi bu satis 9 Agustos'un kasasina duserdi ve
    // 10 Agustos'un kasasini kapatan kisi ekstresiyle tutmayan bir rakam gorurdu.
    addSale({ at: "2026-08-09T22:30:00.000Z", amount: 500 });

    expect(getDaySummary(station.id, "2026-08-10").expectedTotal).toBe(500);
    expect(getDaySummary(station.id, "2026-08-09").expectedTotal).toBe(0);
  });

  it("yerel gun basindan onceki satis onceki gune ait kalir", () => {
    // 2026-08-09 23:00 yerel = 2026-08-09 20:00 UTC
    addSale({ at: "2026-08-09T20:00:00.000Z", amount: 300 });

    expect(getDaySummary(station.id, "2026-08-09").expectedTotal).toBe(300);
    expect(getDaySummary(station.id, "2026-08-10").expectedTotal).toBe(0);
  });

  it("currentBusinessDate yerel gunu dondurur", () => {
    // 2026-08-10 00:30 yerel = 2026-08-09 21:30 UTC
    expect(currentBusinessDate(new Date("2026-08-09T21:30:00.000Z"))).toBe("2026-08-10");
  });
});

describe("getDaySummary", () => {
  it("beklenen tutari brut eksi indirim olarak hesaplar", () => {
    addSale({ at: "2026-08-10T09:00:00.000Z", amount: 1000, discount: 150 });
    addSale({ at: "2026-08-10T10:00:00.000Z", amount: 500 });

    const s = getDaySummary(station.id, "2026-08-10");
    expect(s.transactionCount).toBe(2);
    expect(s.grossAmount).toBe(1500);
    expect(s.discountAmount).toBe(150);
    expect(s.expectedTotal).toBe(1350);
  });

  it("odeme yontemi ve yakit tipi kirilimini verir", () => {
    addSale({ at: "2026-08-10T09:00:00.000Z", amount: 600, method: "iyzico", fuelType: "motorin", liters: 12 });
    addSale({ at: "2026-08-10T10:00:00.000Z", amount: 400, method: "fleet", fuelType: "benzin", liters: 8 });

    const s = getDaySummary(station.id, "2026-08-10");
    expect(s.byPaymentMethod).toEqual([
      { paymentMethod: "iyzico", count: 1, amount: 600 },
      { paymentMethod: "fleet", count: 1, amount: 400 },
    ]);
    expect(s.byFuelType.find((f) => f.fuelType === "benzin")).toEqual({
      fuelType: "benzin",
      count: 1,
      liters: 8,
      amount: 400,
    });
  });

  it("tamamlanmamis islemi tahsilat toplamina katmaz", () => {
    addSale({ at: "2026-08-10T09:00:00.000Z", amount: 1000 });
    addSale({ at: "2026-08-10T10:00:00.000Z", amount: 700, status: "cancelled", paymentStatus: "failed" });

    expect(getDaySummary(station.id, "2026-08-10").expectedTotal).toBe(1000);
  });

  it("parasi bloke ama isi bitmemis islemleri askida olarak isaretler", () => {
    // Mutabakatsizligin en sik sebebi: musteri odedi, yakit akmadi.
    const id = addSale({
      at: "2026-08-10T09:00:00.000Z",
      amount: 800,
      status: "authorized",
      paymentStatus: "authorized",
    });

    const s = getDaySummary(station.id, "2026-08-10");
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]!.id).toBe(id);
    expect(s.expectedTotal).toBe(0);
  });

  it("o gun kesilen iadeyi beklenen tutardan duser ve ayrica raporlar", () => {
    const id = addSale({ at: "2026-08-10T09:00:00.000Z", amount: 1000 });
    addRefund({ transactionId: id, amount: 250, at: "2026-08-10T11:00:00.000Z" });

    const s = getDaySummary(station.id, "2026-08-10");
    expect(s.expectedTotal).toBe(750);
    expect(s.refundedAmount).toBe(250);
    expect(s.refundedCount).toBe(1);
  });

  it("iadeyi islemin gunune degil KESILDIGI gune yazar", () => {
    // Kapanmis bir gunun rakamini geriye donuk degistirmek, imzalanmis bir mutabakati
    // bozmak demek olurdu. Dun satilan, bugun iade edilen para BUGUNUN kasasindan cikar.
    const id = addSale({ at: "2026-08-09T09:00:00.000Z", amount: 1000 });
    addRefund({ transactionId: id, amount: 400, at: "2026-08-10T09:00:00.000Z" });

    expect(getDaySummary(station.id, "2026-08-09").expectedTotal).toBe(1000);
    expect(getDaySummary(station.id, "2026-08-09").refundedAmount).toBe(0);

    const today = getDaySummary(station.id, "2026-08-10");
    expect(today.refundedAmount).toBe(400);
    // O gun hic satis yoksa bile iade kasadan cikmistir: beklenen tutar eksiye duser.
    expect(today.expectedTotal).toBe(-400);
  });

  it("basarisiz iade denemesini kasadan dusmez", () => {
    // Saglayici reddettiyse para hala bizdedir; 'failed' kaydi yalnizca denendigini gosterir.
    const id = addSale({ at: "2026-08-10T09:00:00.000Z", amount: 1000 });
    addRefund({ transactionId: id, amount: 250, at: "2026-08-10T11:00:00.000Z", status: "failed" });

    const s = getDaySummary(station.id, "2026-08-10");
    expect(s.expectedTotal).toBe(1000);
    expect(s.refundedAmount).toBe(0);
  });

  it("baska istasyonun iadesini bu istasyonun kasasindan dusmez", () => {
    const other = createTestStation();
    const otherPump = createTestPump(other.id);
    const otherTx = db
      .prepare(
        `INSERT INTO transactions (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter,
           total_amount, payment_status, status, kiosk_access_token, created_at, completed_at)
         VALUES (?, ?, '06XYZ99', 'motorin', 'amount', 45, 500, 'captured', 'completed', ?, ?, ?)`
      )
      .run(other.id, otherPump, `tok-${Math.random()}`, "2026-08-10T09:00:00.000Z", "2026-08-10T09:00:00.000Z")
      .lastInsertRowid as number;
    db.prepare(
      `INSERT INTO refunds (station_id, transaction_id, amount, reason, payment_method, created_at)
       VALUES (?, ?, 500, 'test', 'iyzico', '2026-08-10T11:00:00.000Z')`
    ).run(other.id, otherTx);

    addSale({ at: "2026-08-10T09:00:00.000Z", amount: 1000 });
    expect(getDaySummary(station.id, "2026-08-10").expectedTotal).toBe(1000);
  });

  it("baska istasyonun satisini karistirmaz", () => {
    const other = createTestStation();
    const otherPump = createTestPump(other.id);
    db.prepare(
      `INSERT INTO transactions (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter,
         total_amount, payment_status, status, kiosk_access_token, created_at, completed_at)
       VALUES (?, ?, '06XYZ99', 'motorin', 'amount', 45, 9999, 'captured', 'completed', 'tok-x', ?, ?)`
    ).run(other.id, otherPump, "2026-08-10T09:00:00.000Z", "2026-08-10T09:00:00.000Z");

    expect(getDaySummary(station.id, "2026-08-10").expectedTotal).toBe(0);
  });
});

describe("closeDay", () => {
  it("beklenen ile gerceklesen arasindaki farki kaydeder", () => {
    addSale({ at: "2026-08-10T09:00:00.000Z", amount: 1000 });

    const rec = closeDay({ stationId: station.id, businessDate: "2026-08-10", declaredTotal: 960, actor });

    expect(rec.expectedTotal).toBe(1000);
    expect(rec.declaredTotal).toBe(960);
    expect(rec.difference).toBe(-40);
    expect(rec.closedBy).toBe(actor.username);
  });

  it("kapanis kirilimini fotograf olarak saklar; sonraki iade gecmis gunu degistirmez", () => {
    const id = addSale({ at: "2026-08-10T09:00:00.000Z", amount: 1000, method: "iyzico" });
    const rec = closeDay({ stationId: station.id, businessDate: "2026-08-10", declaredTotal: 1000, actor });
    expect(rec.breakdown).toEqual([{ paymentMethod: "iyzico", count: 1, amount: 1000 }]);

    // Gun kapandiktan sonra iade gelirse, imzalanmis rakam geriye donuk degismemeli.
    db.prepare("UPDATE transactions SET payment_status = 'refunded' WHERE id = ?").run(id);

    const stored = listReconciliations(station.id).find((r) => r.businessDate === "2026-08-10")!;
    expect(stored.expectedTotal).toBe(1000);
    expect(stored.breakdown).toEqual([{ paymentMethod: "iyzico", count: 1, amount: 1000 }]);
  });

  it("kapanis anindaki askida islem sayisini saklar", () => {
    addSale({ at: "2026-08-10T09:00:00.000Z", amount: 800, status: "authorized", paymentStatus: "authorized" });

    const rec = closeDay({ stationId: station.id, businessDate: "2026-08-10", declaredTotal: 0, actor });
    expect(rec.pendingCount).toBe(1);
  });

  it("ayni gunu iki kez kapatmayi reddeder", () => {
    closeDay({ stationId: station.id, businessDate: "2026-08-10", declaredTotal: 0, actor });

    expect(() => closeDay({ stationId: station.id, businessDate: "2026-08-10", declaredTotal: 0, actor })).toThrow(
      /zaten kapatilmis/
    );
  });

  it("henuz gelmemis bir gunun kasasini kapatmayi reddeder", () => {
    // Gunun geri kalaninda gelecek satislar kapanmis rakamin disinda kalir ve
    // mutabakat sessizce yanlis olurdu.
    const tomorrow = new Date(Date.now() + 48 * 3600 * 1000).toISOString().slice(0, 10);
    expect(() => closeDay({ stationId: station.id, businessDate: tomorrow, declaredTotal: 0, actor })).toThrow(
      /Gelecek bir tarihin/
    );
  });

  it("negatif gerceklesen tutari reddeder", () => {
    expect(() => closeDay({ stationId: station.id, businessDate: "2026-08-10", declaredTotal: -5, actor })).toThrow(
      /negatif/
    );
  });

  it("gecersiz tarih bicimini reddeder", () => {
    expect(() => closeDay({ stationId: station.id, businessDate: "10.08.2026", declaredTotal: 0, actor })).toThrow(
      /Gecersiz tarih/
    );
  });

  it("kapatilan gun ozetin icinde geri doner", () => {
    addSale({ at: "2026-08-10T09:00:00.000Z", amount: 500 });
    closeDay({ stationId: station.id, businessDate: "2026-08-10", declaredTotal: 500, actor });

    const s = getDaySummary(station.id, "2026-08-10");
    expect(s.closed?.difference).toBe(0);
  });

  it("bir istasyonun kapanisi digerini kapatmis saymaz", () => {
    const other = createTestStation();
    closeDay({ stationId: station.id, businessDate: "2026-08-10", declaredTotal: 0, actor });

    expect(getDaySummary(other.id, "2026-08-10").closed).toBeNull();
  });
});
