import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { AlarmRow, StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import {
  PumpTotalizerError,
  getTotalizerStatus,
  listTotalizerReadings,
  recordTotalizerReading,
  updateTotalizerSettings,
} from "./pumpTotalizerService.js";

/**
 * Sayac mutabakati, kaybin NEREDE oldugunu soyleyen kontroldur: tank olcumu "yakit
 * eksildi" der ama tanktan mi sizdi yoksa pompadan kayit disi mi akitildi ayirt etmez.
 */

let station: StationRow;
let actor: UserRow;
let pumpId: number;

function at(step: number): string {
  return new Date(Date.UTC(2026, 7, 1, 0, 0, step)).toISOString();
}

/** Sisteme kaydedilmis, tamamlanmis bir dolum. */
function recordSale(liters: number, when: string, opts: { pumpId?: number; status?: string } = {}): void {
  db.prepare(
    `INSERT INTO transactions
       (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
        total_amount, payment_method, payment_status, status, kiosk_access_token, created_at, completed_at)
     VALUES (?, ?, '34TEST01', 'motorin', 'liters', 50, ?, ?, 'iyzico', 'captured', ?, ?, ?, ?)`
  ).run(
    station.id,
    opts.pumpId ?? pumpId,
    liters,
    liters * 50,
    opts.status ?? "completed",
    `tok-${Math.random()}`,
    when,
    when
  );
}

function alarmsFor(stationId: number): AlarmRow[] {
  return db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? ORDER BY id").all(stationId);
}

function read(totalizer: number, when: string, extra: { meterReset?: boolean } = {}) {
  return recordTotalizerReading({
    stationId: station.id,
    pumpId,
    fuelType: "motorin",
    totalizerLiters: totalizer,
    measuredAt: when,
    actor,
    ...extra,
  });
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  pumpId = createTestPump(station.id, ["motorin"]);
});

describe("ilk okuma", () => {
  it("baslangic noktasidir, sapma uretmez", () => {
    const { reading, alarmRaised } = read(125_000, at(1));
    expect(reading.dispensed_liters).toBe(0);
    expect(reading.recorded_liters).toBe(0);
    expect(reading.variance_liters).toBe(0);
    expect(alarmRaised).toBe(false);
  });
});

describe("sayac ile kayit karsilastirmasi", () => {
  it("sayac ve kayit tutuyorsa sapma yoktur", () => {
    read(125_000, at(1));
    recordSale(600, at(2));
    recordSale(400, at(3));

    const { reading, alarmRaised } = read(126_000, at(4));
    expect(reading.dispensed_liters).toBe(1_000);
    expect(reading.recorded_liters).toBe(1_000);
    expect(reading.variance_liters).toBe(0);
    expect(alarmRaised).toBe(false);
  });

  it("pompa kayittan FAZLA dagitmissa kayit disi cekimi yakalar", () => {
    read(125_000, at(1));
    recordSale(800, at(2));

    // Sayac 1.000 L dagittigini soyluyor ama sisteme yalnizca 800 L kaydedilmis:
    // aradaki 200 L kimsenin odemedigi yakittir.
    const { reading, alarmRaised } = read(126_000, at(3));
    expect(reading.variance_liters).toBe(200);
    expect(alarmRaised).toBe(true);
    expect(alarmsFor(station.id).at(-1)!.message).toContain("KAYIT DISI CEKIM");
  });

  it("sistem sayactan fazla kaydetmisse bunu AYRI bir sorun olarak bildirir", () => {
    read(125_000, at(1));
    recordSale(1_000, at(2));

    // Sisteme 1.000 L kaydedilmis ama sayac 800 L dagitmis: sayac arizasi ya da
    // yakit akmadan tamamlanmis bir islem. Kayit disi cekimden farkli bir sorundur.
    const { reading, alarmRaised } = read(125_800, at(3));
    expect(reading.variance_liters).toBe(-200);
    expect(alarmRaised).toBe(true);
    expect(alarmsFor(station.id).at(-1)!.message).toContain("Sayac arizasi");
  });

  it("iptal edilmis islem 'kaydedilen' sayilmaz", () => {
    read(125_000, at(1));
    recordSale(500, at(2));
    recordSale(500, at(3), { status: "cancelled" }); // yakit akmadi

    const { reading } = read(125_500, at(4));
    expect(reading.recorded_liters).toBe(500);
    expect(reading.variance_liters).toBe(0);
  });

  it("baska pompanin satisi bu pompaya sayilmaz", () => {
    const otherPump = createTestPump(station.id, ["motorin"]);
    read(125_000, at(1));
    recordSale(300, at(2));
    recordSale(700, at(3), { pumpId: otherPump });

    const { reading } = read(125_300, at(4));
    expect(reading.recorded_liters).toBe(300);
    expect(reading.variance_liters).toBe(0);
  });

  it("olcum toleransi icindeki kucuk fark alarm uretmez", () => {
    read(125_000, at(1));
    recordSale(1_000, at(2));
    // 5 L fark, mutlak tabanin (20 L) altinda.
    const { alarmRaised } = read(126_005, at(3));
    expect(alarmRaised).toBe(false);
  });

  it("buyuk hacimde yuzde kucuk kalirsa alarm uretmez", () => {
    read(125_000, at(1));
    recordSale(50_000, at(2));
    // 30 L fark mutlak tabani asiyor ama 50.000 L'nin %0,06'si - esigin altinda.
    const { alarmRaised } = read(175_030, at(3));
    expect(alarmRaised).toBe(false);
  });
});

describe("sayac butunlugu", () => {
  it("geri sayan bir sayac degeri REDDEDILIR", () => {
    read(125_000, at(1));
    // Sessizce kabul edilseydi negatif bir "dagitim" hesaplanir ve mutabakat sacmalardi.
    expect(() => read(124_000, at(2))).toThrow(PumpTotalizerError);
  });

  it("sayac degisimi bilincli olarak isaretlenirse yeni bir baslangic olur", () => {
    read(125_000, at(1));
    const { reading, alarmRaised } = read(0, at(2), { meterReset: true });

    // Eski sayacla yeni sayacin farkini "kayip" saymak sacma olurdu.
    expect(reading.is_meter_reset).toBe(1);
    expect(reading.dispensed_liters).toBe(0);
    expect(reading.variance_liters).toBe(0);
    expect(alarmRaised).toBe(false);
  });

  it("sayac degisiminden sonraki okuma yeni baslangica gore olculur", () => {
    read(125_000, at(1));
    read(0, at(2), { meterReset: true });
    recordSale(400, at(3));

    const { reading } = read(400, at(4));
    expect(reading.dispensed_liters).toBe(400);
    expect(reading.variance_liters).toBe(0);
  });

  it("negatif sayac degeri kabul edilmez", () => {
    expect(() => read(-1, at(1))).toThrow(PumpTotalizerError);
  });

  it("son okumadan onceki bir tarihe okuma eklenemez", () => {
    read(125_000, at(5));
    expect(() => read(126_000, at(2))).toThrow(PumpTotalizerError);
  });

  it("pompanin vermedigi yakit tipi icin okuma girilemez", () => {
    expect(() =>
      recordTotalizerReading({
        stationId: station.id,
        pumpId,
        fuelType: "lpg",
        totalizerLiters: 100,
        actor,
        measuredAt: at(1),
      })
    ).toThrow(PumpTotalizerError);
  });

  it("baska istasyonun pompasina okuma girilemez", () => {
    const foreign = createTestStation();
    expect(() =>
      recordTotalizerReading({
        stationId: foreign.id,
        pumpId,
        fuelType: "motorin",
        totalizerLiters: 100,
        actor,
        measuredAt: at(1),
      })
    ).toThrow(PumpTotalizerError);
  });
});

describe("esik ayarlari", () => {
  it("istasyona ozel esik alarm kararini degistirir", () => {
    updateTotalizerSettings(station.id, { minLiters: 1, thresholdPct: 0.1 }, actor);
    read(125_000, at(1));
    recordSale(1_000, at(2));

    // Varsayilan esikte (20 L) alarm uretmeyen 5 L, daralan esikte uretir.
    const { alarmRaised } = read(126_005, at(3));
    expect(alarmRaised).toBe(true);
  });

  it("gecersiz esik reddedilir", () => {
    expect(() => updateTotalizerSettings(station.id, { thresholdPct: 150 }, actor)).toThrow(PumpTotalizerError);
    expect(() => updateTotalizerSettings(station.id, { minLiters: -5 }, actor)).toThrow(PumpTotalizerError);
  });
});

describe("durum ozeti", () => {
  it("pompa basina son sayac degerini ve son okumadan beri kaydedileni gosterir", () => {
    read(125_000, at(1));
    recordSale(250, at(2));

    const status = getTotalizerStatus(station.id).find((s) => s.pumpId === pumpId && s.fuelType === "motorin")!;
    expect(status.lastTotalizerLiters).toBe(125_000);
    // Bir sonraki okumada sayacin ~250 L artmasi bekleniyor; personel bunu onceden gorur.
    expect(status.recordedSinceLiters).toBe(250);
  });

  it("kumulatif sapma ayni yonde birikir", () => {
    read(125_000, at(1));
    recordSale(800, at(2));
    read(126_000, at(3)); // +200
    recordSale(800, at(4));
    read(127_000, at(5)); // +200

    const status = getTotalizerStatus(station.id).find((s) => s.pumpId === pumpId)!;
    // Tek bir okumadaki salinim olcum hatasidir; surekli ayni yonde biriken toplam
    // sistematik bir sorundur.
    expect(status.cumulativeVarianceLiters).toBe(400);
  });

  it("hic okuma girilmemis pompa da listede yer alir", () => {
    const status = getTotalizerStatus(station.id).find((s) => s.pumpId === pumpId)!;
    expect(status.lastTotalizerLiters).toBeNull();
  });

  it("okuma listesi pompaya gore filtrelenir", () => {
    const otherPump = createTestPump(station.id, ["motorin"]);
    read(125_000, at(1));
    recordTotalizerReading({ stationId: station.id, pumpId: otherPump, fuelType: "motorin", totalizerLiters: 5, actor, measuredAt: at(2) });

    expect(listTotalizerReadings(station.id, { pumpId })).toHaveLength(1);
    expect(listTotalizerReadings(station.id, {})).toHaveLength(2);
  });
});
