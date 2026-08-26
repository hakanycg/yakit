import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { addPlate, createAccount } from "./fleetService.js";
import { getConsumptionReport } from "./fleetConsumptionService.js";

/**
 * Tuketim analizinin degeri, YANLIS OLCUMLERI ELEYEBILMESINDE. Bir sofor 123456
 * yerine 12345 yazdiginda ortaya imkansiz bir tuketim cikar; bu tek satir ortalamayi
 * bozarsa filo sahibi rapora bir daha guvenmez.
 */

let station: StationRow;
let actor: UserRow;
let accountId: number;
let pumpId: number;

const FROM = "2026-07-01";
const TO = "2026-08-31";

function fill(opts: { plate: string; liters: number; odometerKm: number | null; day: number }): void {
  const at = new Date(Date.UTC(2026, 7, opts.day, 10, 0, 0)).toISOString();
  db.prepare(
    `INSERT INTO transactions
       (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
        total_amount, payment_method, payment_status, status, kiosk_access_token, odometer_km, created_at, completed_at)
     VALUES (?, ?, ?, 'motorin', 'liters', 50, ?, ?, 'fleet', 'captured', 'completed', ?, ?, ?, ?)`
  ).run(station.id, pumpId, opts.plate, opts.liters, opts.liters * 50, `tok-${Math.random()}`, opts.odometerKm, at, at);
}

function reportFor(plate: string) {
  return getConsumptionReport(accountId, FROM, TO).plates.find((p) => p.plate === plate);
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  pumpId = createTestPump(station.id);
  accountId = createAccount(station.id, { companyName: "Tuketim Lojistik", billingType: "postpaid" }, actor).id;
  addPlate(station.id, accountId, "34ABC123");
  addPlate(station.id, accountId, "34XYZ999");
});

describe("tuketim hesabi", () => {
  it("iki ardisik dolum arasindan L/100km cikarir", () => {
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    // 500 km sonra 40 L: 40/500*100 = 8 L/100km
    fill({ plate: "34ABC123", liters: 40, odometerKm: 100_500, day: 5 });

    const p = reportFor("34ABC123")!;
    expect(p.litersPer100Km).toBe(8);
    expect(p.sampleCount).toBe(1);
    expect(p.totalDistanceKm).toBe(500);
  });

  it("ilk dolum tek basina tuketim vermez - karsilastirilacak onceki km yok", () => {
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    expect(reportFor("34ABC123")!.litersPer100Km).toBeNull();
  });

  it("ortalama TOPLAM litre / TOPLAM km'den cikar, olcumlerin ortalamasindan degil", () => {
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    fill({ plate: "34ABC123", liters: 80, odometerKm: 101_000, day: 5 }); // 1000 km, 8 L/100km
    fill({ plate: "34ABC123", liters: 2, odometerKm: 101_020, day: 6 }); // 20 km, 10 L/100km

    // Olcumlerin duz ortalamasi 9 olurdu; 20 km'lik bir aralik 1000 km'likle ayni
    // agirligi tasimamali. (80+2)/1020*100 = 8,04
    expect(reportFor("34ABC123")!.litersPer100Km).toBe(8.04);
  });

  it("km girilmemis dolumlar hesaba hic girmez", () => {
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    fill({ plate: "34ABC123", liters: 60, odometerKm: null, day: 3 });
    fill({ plate: "34ABC123", liters: 40, odometerKm: 100_500, day: 5 });

    const p = reportFor("34ABC123")!;
    // Kilometresiz dolum hic sayilmaz; kalan iki dolum arasindan tek olcum cikar.
    expect(p.sampleCount).toBe(1);
    expect(p.litersPer100Km).toBe(8);
  });
});

describe("hatali km girisleri", () => {
  it("bir hane eksik yazilan km ORTALAMAYI BOZMAZ", () => {
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    fill({ plate: "34ABC123", liters: 40, odometerKm: 100_500, day: 5 }); // saglikli: 8 L/100km
    // Sofor 101.000 yerine 10.100 yazdi: km geriye gitti.
    fill({ plate: "34ABC123", liters: 45, odometerKm: 10_100, day: 8 });

    const p = reportFor("34ABC123")!;
    expect(p.litersPer100Km).toBe(8);
    // Atlanan olcum SESSIZCE yok sayilmaz: kac tanesinin kullanilamadigi raporlanir.
    expect(p.skippedPairs).toBeGreaterThan(0);
  });

  it("imkansiz derecede yuksek tuketim ureten cift elenir", () => {
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    // 10 km'de 90 L = 900 L/100km: hicbir yol araci boyle yakmaz, olcum hatasidir.
    fill({ plate: "34ABC123", liters: 90, odometerKm: 100_010, day: 2 });

    const p = reportFor("34ABC123")!;
    expect(p.sampleCount).toBe(0);
    expect(p.skippedPairs).toBe(1);
  });

  it("imkansiz derecede dusuk tuketim ureten cift de elenir", () => {
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    // 50.000 km'de 20 L = 0,04 L/100km: km'ye fazladan hane eklenmis.
    fill({ plate: "34ABC123", liters: 20, odometerKm: 150_000, day: 2 });

    expect(reportFor("34ABC123")!.sampleCount).toBe(0);
  });

  it("ayni km ile girilen ikinci dolum sifira bolme uretmez", () => {
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    fill({ plate: "34ABC123", liters: 30, odometerKm: 100_000, day: 2 });

    const p = reportFor("34ABC123")!;
    expect(p.litersPer100Km).toBeNull();
    expect(p.skippedPairs).toBe(1);
  });
});

describe("filo kiyaslamasi", () => {
  it("filo ortalamasi ve asiri yakan aracin ayirt edilmesi", () => {
    // Normal arac: 8 L/100km
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    fill({ plate: "34ABC123", liters: 80, odometerKm: 101_000, day: 5 });
    // Asiri yakan arac: 20 L/100km
    fill({ plate: "34XYZ999", liters: 100, odometerKm: 50_000, day: 1 });
    fill({ plate: "34XYZ999", liters: 200, odometerKm: 51_000, day: 5 });

    const report = getConsumptionReport(accountId, FROM, TO);
    // (80+200) / 2000 x 100 = 14
    expect(report.fleetAverage).toBe(14);
    // En cok yakan basta gelir: filo sahibi once ona bakmali.
    expect(report.plates[0]!.plate).toBe("34XYZ999");
    expect(report.plates[0]!.litersPer100Km).toBe(20);
  });

  it("baska hesabin araci rapora girmez", () => {
    const other = createAccount(station.id, { companyName: "Baska A.S.", billingType: "postpaid" }, actor).id;
    addPlate(station.id, other, "06ZZZ11");
    fill({ plate: "06ZZZ11", liters: 100, odometerKm: 10_000, day: 1 });
    fill({ plate: "06ZZZ11", liters: 50, odometerKm: 10_500, day: 3 });

    expect(getConsumptionReport(accountId, FROM, TO).plates.find((p) => p.plate === "06ZZZ11")).toBeUndefined();
  });

  it("tarih araligi disindaki dolumlar sayilmaz", () => {
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    fill({ plate: "34ABC123", liters: 40, odometerKm: 100_500, day: 5 });

    const narrow = getConsumptionReport(accountId, "2026-08-10", "2026-08-31");
    expect(narrow.plates).toHaveLength(0);
  });

  it("tamamlanmamis islem hesaba girmez", () => {
    fill({ plate: "34ABC123", liters: 100, odometerKm: 100_000, day: 1 });
    db.prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
          total_amount, payment_method, payment_status, status, kiosk_access_token, odometer_km, created_at, completed_at)
       VALUES (?, ?, '34ABC123', 'motorin', 'liters', 50, 40, 2000, 'fleet', 'captured', 'cancelled', ?, 100500, ?, ?)`
    ).run(station.id, pumpId, `tok-${Math.random()}`, "2026-08-05T10:00:00.000Z", "2026-08-05T10:00:00.000Z");

    expect(reportFor("34ABC123")!.sampleCount).toBe(0);
  });
});
