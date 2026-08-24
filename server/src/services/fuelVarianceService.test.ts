import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { AlarmRow, StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser, setTankStock } from "../test/dbFixture.js";
import { getTank } from "./fuelStockService.js";
import {
  getVarianceSettings,
  getVarianceSummary,
  listReadings,
  recordReading,
  updateVarianceSettings,
} from "./fuelVarianceService.js";

let station: StationRow;
let actor: UserRow;

/**
 * Gercek hayatta olcumler saatler/gunler arayla alinir. Testte hepsi ayni
 * milisaniyeye dusup siralamasi belirsizlesmesin diye her adima acik bir zaman
 * verilir; boylece "hareket hacmi" penceresi de deterministik olur.
 */
function at(step: number): string {
  return new Date(Date.UTC(2026, 7, 1, 0, 0, step)).toISOString();
}

/** Olcumler arasindaki "hareket hacmi" stok hareketlerinden okundugu icin testler gercek satis satirlari yazar. */
function recordSale(stationId: number, liters: number, when: string): void {
  db.prepare(
    `INSERT INTO fuel_stock_movements (station_id, fuel_type, type, liters, balance_after, created_at)
     VALUES (?, 'motorin', 'sale', ?, 0, ?)`
  ).run(stationId, -liters, when);
}

/** Varsayilan tank kapasitesi 10.000 L; buyuk hacimli senaryolar icin yukseltilir. */
function setCapacity(stationId: number, liters: number): void {
  db.prepare("UPDATE fuel_tanks SET capacity_liters = ? WHERE station_id = ? AND fuel_type = 'motorin'").run(liters, stationId);
}

function alarmsFor(stationId: number): AlarmRow[] {
  return db
    .prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = 'fuel_variance_exceeded'")
    .all(stationId);
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
});

describe("recordReading", () => {
  it("kayit stogu ile fiziksel olcum arasindaki farki sapma olarak yazar", () => {
    setTankStock(station.id, "motorin", 8400);

    const { reading } = recordReading({
      stationId: station.id,
      fuelType: "motorin",
      measuredLiters: 8180,
      actor,
    });

    expect(reading.book_liters).toBe(8400);
    expect(reading.measured_liters).toBe(8180);
    expect(reading.variance_liters).toBe(-220);
  });

  it("tank seviyesini fiziksel olcume esitler ve farki denetim izine duzeltme olarak yazar", () => {
    setTankStock(station.id, "motorin", 8400);

    recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 8180, actor });

    expect(getTank(station.id, "motorin").current_liters).toBe(8180);
    const adjustment = db
      .prepare<[number], { liters: number; note: string | null }>(
        "SELECT liters, note FROM fuel_stock_movements WHERE station_id = ? AND type = 'adjustment' ORDER BY id DESC LIMIT 1"
      )
      .get(station.id);
    expect(adjustment?.liters).toBe(-220);
    expect(adjustment?.note).toContain("220 L kayip");
  });

  it("sapma orani tank kapasitesine degil hareket hacmine gore hesaplanir", () => {
    setTankStock(station.id, "motorin", 10000);
    // Ilk olcum bir referans noktasi birakir; oran bir sonraki olcumde bu araliktan hesaplanir.
    recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 10000, measuredAt: at(1), actor });

    recordSale(station.id, 2000, at(2));
    setTankStock(station.id, "motorin", 8000);
    const { reading } = recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 7800, measuredAt: at(3), actor });

    expect(reading.throughput_liters).toBe(2000);
    // 200 / 2000 = %10 -- kapasiteye (10.000 L) bolunseydi %2 gorunup gozden kacardi.
    expect(reading.variance_pct).toBe(10);
  });

  it("esigi asan kayipta kritik alarm uretir ve olcumu alarma baglar", () => {
    setTankStock(station.id, "motorin", 10000);
    recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 10000, measuredAt: at(1), actor });

    recordSale(station.id, 2000, at(2));
    setTankStock(station.id, "motorin", 8000);
    const { reading, alarmRaised } = recordReading({
      stationId: station.id,
      fuelType: "motorin",
      measuredLiters: 7800,
      measuredAt: at(3),
      actor,
    });

    expect(alarmRaised).toBe(true);
    const alarms = alarmsFor(station.id);
    expect(alarms).toHaveLength(1);
    const alarm = alarms[0]!;
    expect(alarm.severity).toBe("critical");
    expect(alarm.message).toContain("200 L KAYIP");
    expect(reading.alarm_id).toBe(alarm.id);
  });

  it("olcum toleransi icindeki kucuk farklar alarm uretmez", () => {
    setCapacity(station.id, 60000);
    setTankStock(station.id, "motorin", 50000);
    recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 50000, measuredAt: at(1), actor });

    recordSale(station.id, 40000, at(2));
    setTankStock(station.id, "motorin", 10000);
    // 40.000 L dolasimda 100 L fark = %0.25; varsayilan esik %0.5.
    const { reading, alarmRaised } = recordReading({
      stationId: station.id,
      fuelType: "motorin",
      measuredLiters: 9900,
      measuredAt: at(3),
      actor,
    });

    expect(reading.variance_pct).toBe(0.25);
    expect(alarmRaised).toBe(false);
    expect(alarmsFor(station.id)).toHaveLength(0);
  });

  it("dusuk hacimli gunlerde yuzde yuksek ciksa bile mutlak taban altindaki farki alarma cevirmez", () => {
    setTankStock(station.id, "motorin", 1000);
    recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 1000, measuredAt: at(1), actor });

    recordSale(station.id, 100, at(2));
    setTankStock(station.id, "motorin", 900);
    // 10 L / 100 L = %10 (oran esigini asar) ama 10 L, 50 L'lik mutlak tabanin altinda.
    const { reading, alarmRaised } = recordReading({
      stationId: station.id,
      fuelType: "motorin",
      measuredLiters: 890,
      measuredAt: at(3),
      actor,
    });

    expect(reading.variance_pct).toBe(10);
    expect(alarmRaised).toBe(false);
  });

  it("kayit disi teslimati isaret eden buyuk FAZLA icin de alarm uretir", () => {
    setTankStock(station.id, "motorin", 5000);
    recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 5000, measuredAt: at(1), actor });

    recordSale(station.id, 2000, at(2));
    setTankStock(station.id, "motorin", 3000);
    const { alarmRaised } = recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 3300, measuredAt: at(3), actor });

    expect(alarmRaised).toBe(true);
    expect(alarmsFor(station.id)[0]!.message).toContain("300 L FAZLA");
  });

  it("tank kapasitesinin uzerindeki olcumu reddeder", () => {
    const capacity = getTank(station.id, "motorin").capacity_liters;
    expect(() =>
      recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: capacity + 1, actor })
    ).toThrow(/kapasitesinden/);
  });

  it("son olcumden onceki bir tarihe olcum eklenmesini engeller", () => {
    recordReading({
      stationId: station.id,
      fuelType: "motorin",
      measuredLiters: 5000,
      measuredAt: "2026-08-20T10:00:00.000Z",
      actor,
    });

    expect(() =>
      recordReading({
        stationId: station.id,
        fuelType: "motorin",
        measuredLiters: 4900,
        measuredAt: "2026-08-19T10:00:00.000Z",
        actor,
      })
    ).toThrow(/son olcumden sonra/);
  });

  it("bir istasyonun olcumu baska istasyonun sapmasini etkilemez", () => {
    const other = createTestStation();
    setTankStock(station.id, "motorin", 5000);
    setTankStock(other.id, "motorin", 5000);

    recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 4000, actor });

    expect(listReadings(other.id, {})).toHaveLength(0);
    expect(getTank(other.id, "motorin").current_liters).toBe(5000);
  });
});

describe("getVarianceSummary", () => {
  it("ayni yonde biriken sapmayi kumulatif olarak toplar", () => {
    setTankStock(station.id, "motorin", 10000);
    recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 10000, measuredAt: at(1), actor });

    let step = 2;
    for (const [sale, measured] of [
      [1000, 8900],
      [1000, 7800],
      [1000, 6700],
    ] as const) {
      recordSale(station.id, sale, at(step++));
      const tank = getTank(station.id, "motorin");
      setTankStock(station.id, "motorin", tank.current_liters - sale);
      recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: measured, measuredAt: at(step++), actor });
    }

    const summary = getVarianceSummary(station.id).find((s) => s.fuelType === "motorin")!;
    expect(summary.readingCount).toBe(4);
    // Her turda 100 L kayip: tek tek bakinca kucuk, kumulatif olarak 300 L.
    expect(summary.totalVarianceLiters).toBe(-300);
    expect(summary.lastVarianceLiters).toBe(-100);
  });
});

describe("varyans ayarlari", () => {
  it("istasyona ozel esik kaydedilir ve alarm karari bu esige gore verilir", () => {
    updateVarianceSettings(station.id, { thresholdPct: 20, minLiters: 10 }, actor);
    expect(getVarianceSettings(station.id)).toEqual({ thresholdPct: 20, minLiters: 10 });

    setTankStock(station.id, "motorin", 10000);
    recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 10000, measuredAt: at(1), actor });
    recordSale(station.id, 2000, at(2));
    setTankStock(station.id, "motorin", 8000);
    // %10 sapma: varsayilan esikte (%0.5) alarm cikardi, %20'lik esikte cikmaz.
    const { alarmRaised } = recordReading({ stationId: station.id, fuelType: "motorin", measuredLiters: 7800, measuredAt: at(3), actor });
    expect(alarmRaised).toBe(false);
  });

  it("gecersiz esik degerini reddeder", () => {
    expect(() => updateVarianceSettings(station.id, { thresholdPct: 150 }, actor)).toThrow(/0 ile 100/);
    expect(() => updateVarianceSettings(station.id, { minLiters: -5 }, actor)).toThrow(/negatif/);
  });
});
