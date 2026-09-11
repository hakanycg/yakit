import { beforeEach, describe, expect, it } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestTransaction, createTestUser } from "../test/dbFixture.js";
import { db } from "../db/index.js";
import {
  LoyaltyError,
  adjustPoints,
  earnPoints,
  expireOldPoints,
  getBalance,
  getLifetimePoints,
  getTier,
  listMovements,
  redeemPoints,
  refundPoints,
  serializeAccount,
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

describe("sadakat kademesi (bronz/gumus/altin)", () => {
  it("getTier esik degerlerine gore dogru kademeyi doner", () => {
    const config = { tierSilverThreshold: 500, tierGoldThreshold: 2000 };
    expect(getTier(0, config)).toBe("bronze");
    expect(getTier(499, config)).toBe("bronze");
    expect(getTier(500, config)).toBe("silver");
    expect(getTier(1999, config)).toBe("silver");
    expect(getTier(2000, config)).toBe("gold");
    expect(getTier(5000, config)).toBe("gold");
  });

  it("kademe MEVCUT bakiyeye degil YASAM BOYU kazanilan puana gore belirlenir - puan harcamak kademe dusurmez", () => {
    setLoyaltyConfig(station.id, { tierSilverThreshold: 100, tierGoldThreshold: 1000 }, actor);
    earnPoints(station.id, "34TIER01", 100, txn()); // 100L x 2 puan = 200 puan -> silver
    expect(serializeAccount(station.id, "34TIER01").tier).toBe("silver");

    redeemPoints(station.id, "34TIER01", 200, txn()); // bakiye 0'a duser
    expect(getBalance(station.id, "34TIER01")).toBe(0);
    expect(getLifetimePoints(station.id, "34TIER01")).toBe(200);
    expect(serializeAccount(station.id, "34TIER01").tier).toBe("silver"); // kademe dusmedi
  });

  it("adjustPoints (manuel duzeltme) yasam boyu puani ETKILEMEZ", () => {
    setLoyaltyConfig(station.id, { tierSilverThreshold: 100, tierGoldThreshold: 1000 }, actor);
    earnPoints(station.id, "34TIER02", 100, txn()); // 200 puan kazanildi
    adjustPoints(station.id, "34TIER02", 10000, "test - buyuk manuel ekleme", actor);

    expect(getBalance(station.id, "34TIER02")).toBe(10000);
    expect(getLifetimePoints(station.id, "34TIER02")).toBe(200); // manuel duzeltme kademeyi etkilemez
  });

  it("yeni bir plaka Bronz kademeyle baslar", () => {
    expect(serializeAccount(station.id, "34TIER03").tier).toBe("bronze");
    expect(serializeAccount(station.id, "34TIER03").lifetimePoints).toBe(0);
  });
});

describe("puan gecerlilik suresi (expireOldPoints)", () => {
  function setUpdatedAt(plate: string, iso: string): void {
    db.prepare("UPDATE loyalty_accounts SET updated_at = ? WHERE station_id = ? AND plate = ?").run(iso, station.id, plate);
  }

  function accountRow(plate: string): { points: number; lifetime_points: number; updated_at: string } {
    return db
      .prepare<[number, string], { points: number; lifetime_points: number; updated_at: string }>(
        "SELECT points, lifetime_points, updated_at FROM loyalty_accounts WHERE station_id = ? AND plate = ?"
      )
      .get(station.id, plate)!;
  }

  const VERY_OLD = "2000-01-01T00:00:00.000Z";

  it("varsayilan KAPALI: pointExpiryEnabled acilmadikca hicbir bakiye sifirlanmaz", () => {
    earnPoints(station.id, "34EXP01", 50, txn()); // 100 puan
    setUpdatedAt("34EXP01", VERY_OLD);

    const results = expireOldPoints();
    expect(results).toHaveLength(0);
    expect(getBalance(station.id, "34EXP01")).toBe(100);
  });

  it("yalnizca kesim tarihinden ONCE hareketsiz kalan hesaplarin bakiyesini sifirlar", () => {
    setLoyaltyConfig(station.id, { pointExpiryEnabled: true, pointExpiryMonths: 12 }, actor);
    earnPoints(station.id, "34EXP02", 50, txn()); // 100 puan - eski
    earnPoints(station.id, "34EXP03", 50, txn()); // 100 puan - taze
    setUpdatedAt("34EXP02", VERY_OLD);

    const results = expireOldPoints();
    expect(results).toHaveLength(1);
    expect(results[0]!.stationId).toBe(station.id);
    expect(results[0]!.accountsExpired).toBe(1);
    expect(results[0]!.pointsExpired).toBe(100);

    expect(getBalance(station.id, "34EXP02")).toBe(0); // eski hesap sifirlandi
    expect(getBalance(station.id, "34EXP03")).toBe(100); // taze hesap dokunulmadi
  });

  it("bakiyeyi sifirlarken updated_at'e DOKUNMAZ (KVKK atil-hesap silme suresini etkilememeli)", () => {
    setLoyaltyConfig(station.id, { pointExpiryEnabled: true, pointExpiryMonths: 12 }, actor);
    earnPoints(station.id, "34EXP04", 50, txn());
    setUpdatedAt("34EXP04", VERY_OLD);

    expireOldPoints();

    const row = accountRow("34EXP04");
    expect(row.points).toBe(0);
    expect(row.updated_at).toBe(VERY_OLD); // degismedi
  });

  it("yasam boyu kazanilan puana (kademeye) DOKUNMAZ", () => {
    setLoyaltyConfig(station.id, { pointExpiryEnabled: true, pointExpiryMonths: 12, tierSilverThreshold: 50 }, actor);
    earnPoints(station.id, "34EXP05", 50, txn()); // 100 puan -> silver
    setUpdatedAt("34EXP05", VERY_OLD);

    expireOldPoints();

    expect(getLifetimePoints(station.id, "34EXP05")).toBe(100);
    expect(serializeAccount(station.id, "34EXP05").tier).toBe("silver"); // kademe dusmedi
  });

  it("dogru tipte bir hareket kaydi birakir", () => {
    setLoyaltyConfig(station.id, { pointExpiryEnabled: true, pointExpiryMonths: 12 }, actor);
    earnPoints(station.id, "34EXP06", 30, txn()); // 60 puan
    setUpdatedAt("34EXP06", VERY_OLD);

    expireOldPoints();

    const movements = listMovements(station.id, { plate: "34EXP06" });
    const expireMovement = movements.find((m) => m.type === "expire")!;
    expect(expireMovement).toBeDefined();
    expect(expireMovement.points).toBe(-60);
    expect(expireMovement.balance_after).toBe(0);
  });

  it("istasyon bazinda izole calisir - baska istasyonun eski hesabini etkilemez", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    setLoyaltyConfig(station.id, { pointExpiryEnabled: true, pointExpiryMonths: 12 }, actor);
    setLoyaltyConfig(other.id, { enabled: true, pointExpiryEnabled: false }, otherActor);

    earnPoints(station.id, "34EXP07", 50, txn()); // bu istasyon: acik
    const otherPump = createTestPump(other.id);
    earnPoints(other.id, "34EXP07", 50, createTestTransaction(other.id, otherPump)); // diger istasyon: kapali
    setUpdatedAt("34EXP07", VERY_OLD);
    db.prepare("UPDATE loyalty_accounts SET updated_at = ? WHERE station_id = ? AND plate = ?").run(VERY_OLD, other.id, "34EXP07");

    expireOldPoints();

    expect(getBalance(station.id, "34EXP07")).toBe(0);
    expect(getBalance(other.id, "34EXP07")).toBe(50); // diger istasyonda ozellik kapali, dokunulmadi (varsayilan pointsPerLiter=1)
  });

  it("0 puanli hesaplari islemez (zaten bos, gereksiz hareket kaydi olusturmaz)", () => {
    setLoyaltyConfig(station.id, { pointExpiryEnabled: true, pointExpiryMonths: 12 }, actor);
    earnPoints(station.id, "34EXP08", 50, txn());
    redeemPoints(station.id, "34EXP08", 100, txn()); // bakiye 0
    setUpdatedAt("34EXP08", VERY_OLD);

    const results = expireOldPoints();
    expect(results).toHaveLength(0);
  });
});
