import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { FuelType, StationRow } from "../db/types.js";
import { createTestPump, createTestStation, setTankStock } from "../test/dbFixture.js";
import { getTank } from "./fuelStockService.js";
import { listReadings } from "./fuelVarianceService.js";
import {
  clearTankGaugeDriverRegistry,
  getTankGaugeDriverFor,
  noopTankGaugeDriver,
  setTankGaugeDriver,
  setTankGaugeDriverFor,
  type TankGaugeDriver,
} from "./tankGaugeDriver.js";
import { loadConfiguredTankGaugeDrivers, sweepTankGauges } from "./tankGaugeService.js";

let station: StationRow;
let pumpId: number;

const HOUR = 60 * 60 * 1000;

/**
 * Belirtilen litreyi donduren sahte prob.
 *
 * Gercek bir prob TEK bir istasyonun tankina baglidir; tarama sistem genelinde
 * calistigindan (ve testler ayni veritabanini paylastigindan) sahte prob de yalnizca
 * test edilen istasyona cevap verir, digerlerine "prob yok" der.
 */
function fixedProbe(stationId: number, liters: number, extra: Partial<{ temperatureCelsius: number }> = {}): TankGaugeDriver {
  return {
    read: (s: number, fuelType: FuelType) =>
      s === stationId && fuelType === "motorin" ? { liters, ...extra } : null,
  };
}

function motorinReadings(stationId: number) {
  return listReadings(stationId, { fuelType: "motorin" });
}

beforeEach(() => {
  station = createTestStation();
  pumpId = createTestPump(station.id);
});

afterEach(() => {
  setTankGaugeDriver(noopTankGaugeDriver);
  clearTankGaugeDriverRegistry();
});

describe("sweepTankGauges", () => {
  it("prob bagli degilken hicbir olcum kaydetmez", () => {
    // Bugunku durum: noop surucu hep null doner.
    setTankGaugeDriver(noopTankGaugeDriver);
    setTankStock(station.id, "motorin", 8000);

    const r = sweepTankGauges();

    expect(r.recorded).toBe(0);
    expect(motorinReadings(station.id)).toHaveLength(0);
  });

  it("prob deger dondurunce olcumu 'auto' kaynakli olarak kaydeder", () => {
    setTankStock(station.id, "motorin", 8000);
    setTankGaugeDriver(fixedProbe(station.id, 7900, { temperatureCelsius: 18.5 }));

    const r = sweepTankGauges();

    expect(r.recorded).toBe(1);
    const readings = motorinReadings(station.id);
    expect(readings).toHaveLength(1);
    expect(readings[0]!.source).toBe("auto");
    expect(readings[0]!.measured_liters).toBe(7900);
    expect(readings[0]!.variance_liters).toBe(-100);
    expect(readings[0]!.temperature_celsius).toBe(18.5);
    // Otomatik olcumun kullanicisi yoktur - denetim izinde uydurma bir kullaniciya yazilmaz.
    expect(readings[0]!.user_id).toBeNull();
  });

  it("okunan degeri tanka isler", () => {
    setTankStock(station.id, "motorin", 8000);
    setTankGaugeDriver(fixedProbe(station.id, 7900));

    sweepTankGauges();

    expect(getTank(station.id, "motorin").current_liters).toBe(7900);
  });

  it("dolum surerken olcum almaz", () => {
    // Yakit akarken seviye hem duser hem calkalanir; probun o andaki okumasi kararsizdir
    // ve gercek bir kayipmis gibi gorunen bir fark uretir.
    setTankStock(station.id, "motorin", 8000);
    setTankGaugeDriver(fixedProbe(station.id, 7000));
    db.prepare(
      `INSERT INTO transactions (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter,
         status, kiosk_access_token) VALUES (?, ?, '34ABC01', 'motorin', 'amount', 45, 'dispensing', 'tok-d')`
    ).run(station.id, pumpId);

    const r = sweepTankGauges();

    expect(r.recorded).toBe(0);
    expect(r.skippedDispensing).toBeGreaterThan(0);
    expect(motorinReadings(station.id)).toHaveLength(0);
  });

  it("teslimat surerken (delivering) o yakit turunun olcumu atlanir", () => {
    // Tanker bosaltirken seviye HIZLA yukselir - bu gercek bir "kazanc" degil,
    // teslimatin kendisidir; okumak sahte bir "sizinti tersi" olayi uretirdi.
    setTankStock(station.id, "motorin", 1000);
    setTankGaugeDriver(fixedProbe(station.id, 6000));
    db.prepare(
      "INSERT INTO fuel_orders (station_id, fuel_type, supplier_name, ordered_liters, status) VALUES (?, 'motorin', 'Test Tedarikci', 5000, 'delivering')"
    ).run(station.id);

    const r = sweepTankGauges();

    expect(r.recorded).toBe(0);
    expect(r.skippedDelivering).toBeGreaterThan(0);
    expect(motorinReadings(station.id)).toHaveLength(0);
  });

  it("teslimat SADECE o yakit turunu etkiler - digerleri normal olculur", () => {
    setTankStock(station.id, "motorin", 1000);
    setTankStock(station.id, "benzin", 1000);
    setTankGaugeDriver({
      read: (s, fuelType) => (s === station.id ? { liters: fuelType === "motorin" ? 6000 : 900 } : null),
    });
    db.prepare(
      "INSERT INTO fuel_orders (station_id, fuel_type, supplier_name, ordered_liters, status) VALUES (?, 'motorin', 'Test Tedarikci', 5000, 'delivering')"
    ).run(station.id);

    const r = sweepTankGauges();

    expect(motorinReadings(station.id)).toHaveLength(0);
    expect(listReadings(station.id, { fuelType: "benzin" })).toHaveLength(1);
    expect(r.skippedDelivering).toBeGreaterThan(0);
  });

  it("saatlik esikten once ikinci olcum almaz", () => {
    // Sik olcum sapma takibini BOZAR: aradaki hacim sifira yaklasir ve probun normal
    // salinimi yuzde olarak devasa gorunur.
    setTankStock(station.id, "motorin", 8000);
    setTankGaugeDriver(fixedProbe(station.id, 7900));
    const t0 = Date.now();

    expect(sweepTankGauges(t0).recorded).toBe(1);
    const second = sweepTankGauges(t0 + 30 * 60 * 1000);

    expect(second.recorded).toBe(0);
    expect(second.skippedTooSoon).toBeGreaterThan(0);
    expect(motorinReadings(station.id)).toHaveLength(1);
  });

  it("esik gecince yeniden olcer", () => {
    setTankStock(station.id, "motorin", 8000);
    setTankGaugeDriver(fixedProbe(station.id, 7900));
    const t0 = Date.now();

    sweepTankGauges(t0);
    setTankGaugeDriver(fixedProbe(station.id, 7800));
    const later = sweepTankGauges(t0 + HOUR + 60_000);

    expect(later.recorded).toBe(1);
    expect(motorinReadings(station.id)).toHaveLength(2);
  });

  it("prob hata firlatirsa diger tanklari engellemez", () => {
    setTankStock(station.id, "motorin", 8000);
    setTankStock(station.id, "benzin", 5000);
    setTankGaugeDriver({
      read: (s, fuelType) => {
        if (s !== station.id) return null;
        if (fuelType === "motorin") throw new Error("prob zaman asimi");
        return fuelType === "benzin" ? { liters: 4900 } : null;
      },
    });

    const r = sweepTankGauges();

    expect(r.recorded).toBe(1);
    expect(listReadings(station.id, { fuelType: "benzin" })).toHaveLength(1);
    expect(motorinReadings(station.id)).toHaveLength(0);
  });

  it("gecersiz deger donduren probu yok sayar", () => {
    setTankStock(station.id, "motorin", 8000);
    setTankGaugeDriver({ read: (s) => (s === station.id ? { liters: Number.NaN } : null) });

    const r = sweepTankGauges();

    expect(r.recorded).toBe(0);
    expect(motorinReadings(station.id)).toHaveLength(0);
  });

  it("negatif deger donduren probu yok sayar", () => {
    setTankStock(station.id, "motorin", 8000);
    setTankGaugeDriver({ read: (s) => (s === station.id ? { liters: -5 } : null) });

    expect(sweepTankGauges().recorded).toBe(0);
    expect(motorinReadings(station.id)).toHaveLength(0);
  });

  it("pasif istasyonu taramaz", () => {
    setTankStock(station.id, "motorin", 8000);
    setTankGaugeDriver(fixedProbe(station.id, 7900));
    db.prepare("UPDATE stations SET active = 0 WHERE id = ?").run(station.id);

    sweepTankGauges();

    expect(motorinReadings(station.id)).toHaveLength(0);
  });

  it("esigi asan otomatik olcum de alarm uretir", () => {
    // Otomatik olcum, elle girilen olcumle AYNI yoldan (recordReading) gecer; esik
    // kontrolu ve alarm uretimi tek yerde kalir.
    setTankStock(station.id, "motorin", 10000);
    setTankGaugeDriver(fixedProbe(station.id, 10000));
    const t0 = Date.now();
    sweepTankGauges(t0);

    db.prepare(
      `INSERT INTO fuel_stock_movements (station_id, fuel_type, type, liters, balance_after, created_at)
       VALUES (?, 'motorin', 'sale', -2000, 0, ?)`
    ).run(station.id, new Date(t0 + HOUR).toISOString());
    setTankStock(station.id, "motorin", 8000);
    setTankGaugeDriver(fixedProbe(station.id, 7750));

    const r = sweepTankGauges(t0 + HOUR + 60_000);

    expect(r.recorded).toBe(1);
    expect(r.alarmsRaised).toBe(1);
    const alarm = db
      .prepare<[number], { message: string }>(
        "SELECT message FROM alarms WHERE station_id = ? AND type = 'fuel_variance_exceeded'"
      )
      .get(station.id);
    expect(alarm?.message).toContain("250 L KAYIP");
  });
});

describe("coklu tank cihazi mimarisi (per-tank driver registry)", () => {
  it("bir tanka ozel surucu tanimlanmadiysa varsayilan surucu kullanilir", () => {
    setTankGaugeDriver(fixedProbe(station.id, 5000));
    expect(getTankGaugeDriverFor(station.id, "motorin").read(station.id, "motorin")).toEqual({ liters: 5000 });
  });

  it("bir tanka ozel surucu, varsayilani gecersiz kilar - digerlerini etkilemez", () => {
    setTankGaugeDriver({ read: () => ({ liters: 5000 }) });
    setTankGaugeDriverFor(station.id, "motorin", { read: () => ({ liters: 9999 }) });

    expect(getTankGaugeDriverFor(station.id, "motorin").read(station.id, "motorin")).toEqual({ liters: 9999 });
    // Ayni istasyonda farkli bir yakit turu hala varsayilani kullanir - iki "marka"
    // ayni anda, birbirinden bagimsiz calisabiliyor.
    expect(getTankGaugeDriverFor(station.id, "benzin").read(station.id, "benzin")).toEqual({ liters: 5000 });
  });

  it("farkli istasyonlarin ozel surucu kayitlari birbirine karismaz", () => {
    const otherStation = createTestStation();
    setTankGaugeDriverFor(station.id, "motorin", { read: () => ({ liters: 111 }) });
    setTankGaugeDriverFor(otherStation.id, "motorin", { read: () => ({ liters: 222 }) });

    expect(getTankGaugeDriverFor(station.id, "motorin").read(station.id, "motorin")).toEqual({ liters: 111 });
    expect(getTankGaugeDriverFor(otherStation.id, "motorin").read(otherStation.id, "motorin")).toEqual({ liters: 222 });
  });

  it("loadConfiguredTankGaugeDrivers, marka tanimli tanklari kayit defterine ekler (henuz noop olarak)", () => {
    db.prepare("UPDATE fuel_tanks SET probe_brand = 'veeder_root' WHERE station_id = ? AND fuel_type = 'motorin'").run(station.id);

    loadConfiguredTankGaugeDrivers();

    // Gercek Veeder-Root surucusu henuz yok - kayitli surucu noop olmali, gercek
    // donanim baglaninca burasi degisecek (bkz. tankGaugeService.ts yorumu).
    expect(getTankGaugeDriverFor(station.id, "motorin")).toBe(noopTankGaugeDriver);
  });
});
