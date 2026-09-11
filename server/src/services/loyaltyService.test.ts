import { beforeEach, describe, expect, it } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestTransaction, createTestUser } from "../test/dbFixture.js";
import { db } from "../db/index.js";
import {
  LoyaltyError,
  adjustPoints,
  earnPoints,
  getBalance,
  listMovements,
  redeemPoints,
  refundPoints,
  setLoyaltyConfig,
  setMarketingConsent,
} from "./loyaltyService.js";

/**
 * Sadakat puani PARADIR: musteri onu indirime cevirir. Bu yuzden buradaki aritmetigin
 * bir regresyonda sessizce yanlis calismasi, kasadan para cikmasi demektir.
 */

let station: StationRow;
let actor: UserRow;
let pumpId: number;

function txn(): number {
  return createTestTransaction(station.id, pumpId);
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  pumpId = createTestPump(station.id);
  setLoyaltyConfig(station.id, { enabled: true, pointsPerLiter: 2, pointValueTry: 0.5 }, actor);
});

describe("puan kazanma", () => {
  it("dagitilan litreye gore puan yazar", () => {
    const earned = earnPoints(station.id, "34ABC123", 10, txn());
    expect(earned).toBe(20); // 10 L x 2 puan
    expect(getBalance(station.id, "34ABC123")).toBe(20);
  });

  it("program kapaliyken puan yazilmaz", () => {
    setLoyaltyConfig(station.id, { enabled: false }, actor);
    expect(earnPoints(station.id, "34ABC123", 10, txn())).toBe(0);
    expect(getBalance(station.id, "34ABC123")).toBe(0);
  });

  it("sifir litrelik islem puan kazandirmaz", () => {
    expect(earnPoints(station.id, "34ABC123", 0, txn())).toBe(0);
  });

  it("plaka yazimi puan bakiyesini bolmez", () => {
    // "34 abc 123" ile "34 ABC 123" ayni araçtir; ayri hesap acilsaydi musteri
    // puanlarini kaybederdi.
    earnPoints(station.id, "34 abc 123", 5, txn());
    earnPoints(station.id, "  34  ABC  123 ", 5, txn());
    expect(getBalance(station.id, "34 ABC 123")).toBe(20);
  });

  it("baska istasyonun puani bu istasyonda gorunmez", () => {
    const other = createTestStation();
    earnPoints(station.id, "34ABC123", 10, txn());
    expect(getBalance(other.id, "34ABC123")).toBe(0);
  });
});

describe("puan kullanma", () => {
  it("kullanilan puan TL indirimine cevrilir ve bakiyeden duser", () => {
    earnPoints(station.id, "34ABC123", 50, txn()); // 100 puan
    const discount = redeemPoints(station.id, "34ABC123", 40, txn());
    expect(discount).toBe(20); // 40 puan x 0,50 TL
    expect(getBalance(station.id, "34ABC123")).toBe(60);
  });

  it("bakiyeden fazla puan kullanilamaz", () => {
    earnPoints(station.id, "34ABC123", 5, txn()); // 10 puan
    expect(() => redeemPoints(station.id, "34ABC123", 11, txn())).toThrow(LoyaltyError);
    // Basarisiz denemeden sonra bakiye bozulmamali.
    expect(getBalance(station.id, "34ABC123")).toBe(10);
  });

  it("sifir ya da negatif puan kullanilamaz", () => {
    earnPoints(station.id, "34ABC123", 5, txn());
    expect(() => redeemPoints(station.id, "34ABC123", 0, txn())).toThrow(LoyaltyError);
    expect(() => redeemPoints(station.id, "34ABC123", -5, txn())).toThrow(LoyaltyError);
  });

  it("hic puani olmayan plaka puan kullanamaz", () => {
    expect(() => redeemPoints(station.id, "99ZZZ99", 1, txn())).toThrow(LoyaltyError);
  });
});

describe("puan iadesi", () => {
  it("iptal olan islemde kullanilan puan geri yazilir", () => {
    earnPoints(station.id, "34ABC123", 50, txn()); // 100 puan
    const transactionId = txn();
    redeemPoints(station.id, "34ABC123", 40, transactionId);
    refundPoints(station.id, "34ABC123", 40, transactionId);
    expect(getBalance(station.id, "34ABC123")).toBe(100);
  });

  it("sifir puanli iade hicbir hareket yazmaz", () => {
    earnPoints(station.id, "34ABC123", 5, txn());
    const before = listMovements(station.id, { plate: "34ABC123" }).length;
    refundPoints(station.id, "34ABC123", 0, txn());
    expect(listMovements(station.id, { plate: "34ABC123" })).toHaveLength(before);
  });
});

describe("manuel duzeltme", () => {
  it("yonetici bakiyeyi dogrudan ayarlayabilir ve hareket kaydi birakir", () => {
    earnPoints(station.id, "34ABC123", 10, txn()); // 20 puan
    const account = adjustPoints(station.id, "34ABC123", 75, "Musteri sikayeti", actor);
    expect(account.points).toBe(75);

    const movements = listMovements(station.id, { plate: "34ABC123" });
    const adjustment = movements.find((m) => m.type === "adjustment")!;
    // Duzeltme, FARKI yazar: denetimde "ne kadar eklendi" gorunmeli.
    expect(adjustment.points).toBe(55);
    expect(adjustment.balance_after).toBe(75);
    expect(adjustment.user_id).toBe(actor.id);
  });

  it("bakiye negatife ayarlanamaz", () => {
    expect(() => adjustPoints(station.id, "34ABC123", -1, "hata", actor)).toThrow(LoyaltyError);
  });
});

describe("hareket defteri", () => {
  it("her hareket bakiyenin o anki halini saklar", () => {
    earnPoints(station.id, "34ABC123", 10, txn()); // +20 -> 20
    redeemPoints(station.id, "34ABC123", 5, txn()); // -5 -> 15

    const movements = listMovements(station.id, { plate: "34ABC123" });
    const balances = movements.map((m) => m.balance_after).sort((a, b) => a - b);
    expect(balances).toEqual([15, 20]);
    // Defterdeki puan toplami her zaman guncel bakiyeye esit olmali.
    const sum = movements.reduce((n, m) => n + m.points, 0);
    expect(sum).toBe(getBalance(station.id, "34ABC123"));
  });
});

describe("kampanya rizasi - iletisim kanali (bkz. gorev #229)", () => {
  function contactInfo(plate: string): { contact_email: string | null; contact_phone: string | null } {
    return db
      .prepare<[number, string], { contact_email: string | null; contact_phone: string | null }>(
        "SELECT contact_email, contact_phone FROM loyalty_accounts WHERE station_id = ? AND plate = ?"
      )
      .get(station.id, plate)!;
  }

  it("bir sonraki ziyarette yalnizca telefon girilirse, once kaydedilen e-posta SILINMEZ", () => {
    setMarketingConsent(station.id, "34XYZ01", true, "musteri@example.com", null);
    expect(contactInfo("34XYZ01")).toEqual({ contact_email: "musteri@example.com", contact_phone: null });

    setMarketingConsent(station.id, "34XYZ01", true, null, "+905551234567");
    expect(contactInfo("34XYZ01")).toEqual({ contact_email: "musteri@example.com", contact_phone: "+905551234567" });
  });

  it("yeni bir deger girilirse eskisinin yerine gecer (silinmez ama guncellenir)", () => {
    setMarketingConsent(station.id, "34XYZ02", true, "eski@example.com", null);
    setMarketingConsent(station.id, "34XYZ02", true, "yeni@example.com", null);
    expect(contactInfo("34XYZ02")).toEqual({ contact_email: "yeni@example.com", contact_phone: null });
  });
});
