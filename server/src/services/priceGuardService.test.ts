import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestFuelPrice, createTestStation, createTestUser } from "../test/dbFixture.js";
import {
  PriceGuardError,
  assertPriceChangeAllowed,
  evaluatePriceChange,
  getPriceGuardSettings,
  updatePriceGuardSettings,
} from "./priceGuardService.js";

let station: StationRow;
let actor: UserRow;

function setAverageCost(stationId: number, cost: number): void {
  db.prepare("UPDATE fuel_tanks SET average_cost_per_liter = ? WHERE station_id = ? AND fuel_type = 'motorin'").run(cost, stationId);
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  createTestFuelPrice(station.id, "motorin", 54.2);
});

describe("sapma kontrolu", () => {
  it("ondalik kaymasini yakalar", () => {
    // 54,20 yerine 5,42: dogrulamadan gecen ama istasyonu bir gecede batiran hata.
    const w = evaluatePriceChange(station.id, "motorin", 5.42)!;

    expect(w.requiresConfirmation).toBe(true);
    expect(w.exceedsThreshold).toBe(true);
    expect(w.changePct).toBe(-90);
    expect(w.message).toContain("5.42");
    expect(w.message).toContain("54.20");
  });

  it("ters yondeki kaymayi da yakalar", () => {
    // 542,00: musteriler on kat fazla oder.
    expect(evaluatePriceChange(station.id, "motorin", 542)!.exceedsThreshold).toBe(true);
  });

  it("normal gunluk zamda onay istemez", () => {
    // %1.5'luk bir zam gercek hayatta siradandir; her seferinde onay istemek uyariyi
    // anlamsizlastirir ve kullanici gozu kapali onaylamayi ogrenir.
    expect(evaluatePriceChange(station.id, "motorin", 55.0)).toBeNull();
  });

  it("esik tam sinirdayken onay istemez, asinca ister", () => {
    expect(evaluatePriceChange(station.id, "motorin", 54.2 * 1.2)).toBeNull();
    expect(evaluatePriceChange(station.id, "motorin", 54.2 * 1.21)!.exceedsThreshold).toBe(true);
  });

  it("esik istasyon bazinda degistirilebilir", () => {
    updatePriceGuardSettings(station.id, 1, actor);

    expect(evaluatePriceChange(station.id, "motorin", 55.0)!.exceedsThreshold).toBe(true);
  });

  it("gecersiz esigi reddeder", () => {
    expect(() => updatePriceGuardSettings(station.id, 150, actor)).toThrow(PriceGuardError);
    expect(() => updatePriceGuardSettings(station.id, -1, actor)).toThrow(PriceGuardError);
  });

  it("varsayilan esik %20", () => {
    expect(getPriceGuardSettings(station.id).maxChangePct).toBe(20);
  });

  it("tanimsiz yakit tipinde uyari uretmez", () => {
    expect(evaluatePriceChange(station.id, "lpg", 1)).toBeNull();
  });
});

describe("maliyet alti satis kontrolu", () => {
  it("yeni fiyat ortalama maliyetin altindaysa uyarir", () => {
    setAverageCost(station.id, 50);

    const w = evaluatePriceChange(station.id, "motorin", 48)!;

    expect(w.belowCost).toBe(true);
    expect(w.message).toContain("zararina satis");
  });

  it("sapma esigi asilmasa bile maliyet alti uyari verir", () => {
    // Iki kontrol birbirinin yerine gecmez: maliyet yukselmisken fiyati sabit birakmak
    // kucuk bir degisiklikle zararina satisa yol acabilir.
    setAverageCost(station.id, 55);

    const w = evaluatePriceChange(station.id, "motorin", 54.0)!;

    expect(w.exceedsThreshold).toBe(false);
    expect(w.belowCost).toBe(true);
    expect(w.requiresConfirmation).toBe(true);
  });

  it("maliyet bilinmiyorsa (0) maliyet karsilastirmasi yapmaz", () => {
    // Maliyeti girilmemis teslimatlar ortalamayi etkilemez; 0 "bedava aldik" degil
    // "bilmiyoruz" demektir.
    setAverageCost(station.id, 0);

    expect(evaluatePriceChange(station.id, "motorin", 54.0)).toBeNull();
  });

  it("maliyetin ustundeki fiyatta uyarmaz", () => {
    setAverageCost(station.id, 50);

    expect(evaluatePriceChange(station.id, "motorin", 54.0)).toBeNull();
  });
});

describe("onay kapisi", () => {
  it("onaysiz olagandisi degisikligi reddeder", () => {
    expect(() => assertPriceChangeAllowed(station.id, "motorin", 5.42, false)).toThrow(PriceGuardError);
  });

  it("onayla gecirir", () => {
    // Bu bir YASAK degil hiz kesici: gercek fiyat siciramalari olur.
    expect(() => assertPriceChangeAllowed(station.id, "motorin", 5.42, true)).not.toThrow();
  });

  it("normal degisikligi onaysiz gecirir", () => {
    expect(() => assertPriceChangeAllowed(station.id, "motorin", 55.0, false)).not.toThrow();
  });

  it("hata, ekranda gosterilecek uyari detayini tasir", () => {
    try {
      assertPriceChangeAllowed(station.id, "motorin", 5.42, false);
      throw new Error("beklenen hata firlatilmadi");
    } catch (err) {
      const guard = err as PriceGuardError;
      expect(guard.status).toBe(409);
      expect((guard.details as { priceGuard: { changePct: number } }).priceGuard.changePct).toBe(-90);
    }
  });
});
