import { beforeEach, describe, expect, it } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { db } from "../db/index.js";
import { getBalance, getLifetimePoints, getTier, listMovements, serializeAccount, setLoyaltyConfig } from "./loyaltyService.js";
import { completeReferral, listReferrals, tryRegisterReferral } from "./referralService.js";

let station: StationRow;
let actor: UserRow;
let pumpId: number;

/** createTestTransaction (dbFixture) her zaman 'created' durumunda ve sabit plakayla
 * ekler - referral testleri BELIRLI bir plaka + status icin kontrol gerektirdiginden
 * burada dogrudan bir satir eklenir. */
function insertTransaction(plate: string, status: "created" | "completed"): number {
  const result = db
    .prepare(
      `INSERT INTO transactions (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, kiosk_access_token, status)
       VALUES (?, ?, ?, 'benzin', 'amount', 44.5, ?, ?)`
    )
    .run(station.id, pumpId, plate, `test-token-${Date.now()}-${Math.random()}`, status);
  return result.lastInsertRowid as number;
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  pumpId = createTestPump(station.id);
  setLoyaltyConfig(station.id, { enabled: true, referralEnabled: true, referralBonusPoints: 100, referralRefereeBonusPoints: 50 }, actor);
});

describe("tryRegisterReferral", () => {
  it("varsayilan KAPALI: referralEnabled false iken kayit acilmaz", () => {
    setLoyaltyConfig(station.id, { referralEnabled: false }, actor);
    const row = tryRegisterReferral(station.id, "34REF01", "34REF02");
    expect(row).toBeNull();
  });

  it("kendi kendini yonlendirme reddedilir", () => {
    const row = tryRegisterReferral(station.id, "34REF01", "34REF01");
    expect(row).toBeNull();
  });

  it("referred plakanin bu istasyonda daha once TAMAMLANMIS bir islemi varsa reddedilir (zaten mevcut musteri)", () => {
    insertTransaction("34REF03", "completed");
    const row = tryRegisterReferral(station.id, "34REF01", "34REF03");
    expect(row).toBeNull();
  });

  it("referred plakanin sadece 'created' (odenmemis) islemi varsa yine de uygun kabul edilir", () => {
    insertTransaction("34REF04", "created");
    const row = tryRegisterReferral(station.id, "34REF01", "34REF04");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
  });

  it("uygun bir kayit 'pending' olarak acilir", () => {
    const row = tryRegisterReferral(station.id, "34REF05", "34REF06");
    expect(row).not.toBeNull();
    expect(row!.referrer_plate).toBe("34REF05");
    expect(row!.referred_plate).toBe("34REF06");
    expect(row!.status).toBe("pending");
  });

  it("ayni referred plaka icin ikinci kayit reddedilir (UNIQUE(station_id, referred_plate))", () => {
    const first = tryRegisterReferral(station.id, "34REF07", "34REF08");
    expect(first).not.toBeNull();
    const second = tryRegisterReferral(station.id, "34REF09", "34REF08");
    expect(second).toBeNull();
  });

  it("baska bir istasyonda ayni referred plaka ile kayit acmak serbesttir (istasyon bazinda izole)", () => {
    tryRegisterReferral(station.id, "34REF10", "34REF11");
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    setLoyaltyConfig(other.id, { enabled: true, referralEnabled: true }, otherActor);
    const row = tryRegisterReferral(other.id, "34REF12", "34REF11");
    expect(row).not.toBeNull();
  });
});

describe("completeReferral", () => {
  it("bekleyen referral yoksa sessizce hicbir sey yapmaz", () => {
    expect(() => completeReferral(station.id, "34NOREF", insertTransaction("34NOREF", "completed"))).not.toThrow();
  });

  it("referred plakanin ILK tamamlanan islemi olunca her iki tarafa da bonus verir", () => {
    tryRegisterReferral(station.id, "34REF20", "34REF21");
    const txId = insertTransaction("34REF21", "completed");

    completeReferral(station.id, "34REF21", txId);

    expect(getBalance(station.id, "34REF20")).toBe(100); // referrer bonusu
    expect(getBalance(station.id, "34REF21")).toBe(50); // referee (hos geldin) bonusu

    const referrals = listReferrals(station.id, { plate: "34REF20" });
    expect(referrals).toHaveLength(1);
    expect(referrals[0]!.status).toBe("completed");
    expect(referrals[0]!.referrer_bonus_points).toBe(100);
    expect(referrals[0]!.referred_bonus_points).toBe(50);
    expect(referrals[0]!.transaction_id).toBe(txId);
  });

  it("bonus puanlar YASAM BOYU puana (kademeye) da sayilir", () => {
    setLoyaltyConfig(station.id, { tierSilverThreshold: 80 }, actor);
    tryRegisterReferral(station.id, "34REF22", "34REF23");
    const txId = insertTransaction("34REF23", "completed");
    completeReferral(station.id, "34REF23", txId);

    expect(getLifetimePoints(station.id, "34REF22")).toBe(100);
    expect(serializeAccount(station.id, "34REF22").tier).toBe(getTier(100, { tierSilverThreshold: 80, tierGoldThreshold: 999999 }));
  });

  it("ayni referral iki kez tamamlanamaz (ikinci cagri no-op)", () => {
    tryRegisterReferral(station.id, "34REF24", "34REF25");
    const txId = insertTransaction("34REF25", "completed");
    completeReferral(station.id, "34REF25", txId);

    const secondTxId = insertTransaction("34REF25", "completed");
    completeReferral(station.id, "34REF25", secondTxId);

    // Bonus yalnizca BIR kez verilmis olmali.
    expect(getBalance(station.id, "34REF24")).toBe(100);
    expect(getBalance(station.id, "34REF25")).toBe(50);
  });

  it("dogru tipte hareket kayitlari birakir", () => {
    tryRegisterReferral(station.id, "34REF26", "34REF27");
    const txId = insertTransaction("34REF27", "completed");
    completeReferral(station.id, "34REF27", txId);

    const referrerMovements = listMovements(station.id, { plate: "34REF26" });
    expect(referrerMovements.find((m) => m.type === "referral")).toBeDefined();

    const refereeMovements = listMovements(station.id, { plate: "34REF27" });
    const refereeMovement = refereeMovements.find((m) => m.type === "referral")!;
    expect(refereeMovement.transaction_id).toBe(txId);
  });

  it("program bu arada kapatilirsa bonus verilmez ve kayit pending kalir", () => {
    tryRegisterReferral(station.id, "34REF28", "34REF29");
    setLoyaltyConfig(station.id, { referralEnabled: false }, actor);
    const txId = insertTransaction("34REF29", "completed");
    completeReferral(station.id, "34REF29", txId);

    expect(getBalance(station.id, "34REF28")).toBe(0);
    const referrals = listReferrals(station.id, { plate: "34REF29" });
    expect(referrals[0]!.status).toBe("pending");
  });
});

describe("listReferrals", () => {
  it("plaka filtresi hem referrer hem referred tarafinda eslesir", () => {
    tryRegisterReferral(station.id, "34REF30", "34REF31");
    expect(listReferrals(station.id, { plate: "34REF30" })).toHaveLength(1);
    expect(listReferrals(station.id, { plate: "34REF31" })).toHaveLength(1);
    expect(listReferrals(station.id, { plate: "34REF99" })).toHaveLength(0);
  });
});
