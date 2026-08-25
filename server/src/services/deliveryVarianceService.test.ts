import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { addStock, getTank } from "./fuelStockService.js";
import {
  DeliveryVarianceError,
  evaluateDelivery,
  getSupplierDeliveryVariance,
  updateDeliveryVarianceSettings,
} from "./deliveryVarianceService.js";

let station: StationRow;
let actor: UserRow;

function setCapacity(stationId: number, liters: number): void {
  db.prepare("UPDATE fuel_tanks SET capacity_liters = ? WHERE station_id = ?").run(liters, stationId);
}

function activeShortDeliveryAlarms(stationId: number): { message: string }[] {
  return db
    .prepare<[number], { message: string }>(
      "SELECT message FROM alarms WHERE station_id = ? AND type = 'short_delivery' AND status = 'active'"
    )
    .all(stationId);
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  setCapacity(station.id, 100000);
});

describe("kabul farki hesabi", () => {
  it("olcum yoksa irsaliye miktarini kabul eder ve farki NULL birakir", () => {
    // "Olctuk, tuttu" ile "hic olcmedik" ayni sey degildir; 0 yazmak ikincisini
    // birincisi gibi gosterirdi.
    const r = evaluateDelivery(station.id, { declaredLiters: 20000 });

    expect(r.acceptedLiters).toBe(20000);
    expect(r.varianceLiters).toBeNull();
    expect(r.unmeasured).toBe(true);
    expect(r.exceedsThreshold).toBe(false);
  });

  it("yalnizca bir olcum girilirse fark hesaplanamaz", () => {
    expect(evaluateDelivery(station.id, { declaredLiters: 20000, measuredBefore: 5000 }).unmeasured).toBe(true);
    expect(evaluateDelivery(station.id, { declaredLiters: 20000, measuredAfter: 25000 }).unmeasured).toBe(true);
  });

  it("eksik teslimatta farki ve yuzdeyi hesaplar", () => {
    const r = evaluateDelivery(station.id, { declaredLiters: 20000, measuredBefore: 5000, measuredAfter: 24600 });

    expect(r.acceptedLiters).toBe(19600);
    expect(r.varianceLiters).toBe(-400);
    expect(r.variancePct).toBe(2);
    expect(r.exceedsThreshold).toBe(true);
  });

  it("yuzdeyi IRSALIYE miktarina boler", () => {
    // Fiilen girene bolmek, eksik geldikce paydayi kucultup farki oldugundan buyuk
    // gosterirdi: 400/19600 = %2.04, dogrusu 400/20000 = %2.00.
    expect(evaluateDelivery(station.id, { declaredLiters: 20000, measuredBefore: 0, measuredAfter: 19600 }).variancePct).toBe(2);
  });

  it("tolerans icindeki farkta alarm esigini asmaz", () => {
    // %0.4 fark: yuzde esigi (%0.5) asilmadi.
    const r = evaluateDelivery(station.id, { declaredLiters: 20000, measuredBefore: 0, measuredAfter: 19920 });

    expect(r.varianceLiters).toBe(-80);
    expect(r.exceedsThreshold).toBe(false);
  });

  it("yuzde asilsa bile mutlak taban asilmadikca alarm uretmez", () => {
    // 500 L'lik teslimatta %2 sadece 10 L eder; olcum hassasiyeti bunun altindadir.
    const r = evaluateDelivery(station.id, { declaredLiters: 500, measuredBefore: 0, measuredAfter: 490 });

    expect(r.variancePct).toBe(2);
    expect(r.varianceLiters).toBe(-10);
    expect(r.exceedsThreshold).toBe(false);
  });

  it("FAZLA gelen teslimatta alarm uretmez ama farki kaydeder", () => {
    // Fazlasi istasyonun aleyhine degil; kritik alarm kuyrugunu doldurmasi gercek
    // alarmlarin kacirilmasina yol acardi.
    const r = evaluateDelivery(station.id, { declaredLiters: 20000, measuredBefore: 0, measuredAfter: 20500 });

    expect(r.varianceLiters).toBe(500);
    expect(r.exceedsThreshold).toBe(false);
  });

  it("esikler istasyon bazinda degistirilebilir", () => {
    updateDeliveryVarianceSettings(station.id, { thresholdPct: 0.1, minLiters: 10 }, actor);

    expect(evaluateDelivery(station.id, { declaredLiters: 20000, measuredBefore: 0, measuredAfter: 19950 }).exceedsThreshold).toBe(true);
  });

  it("gecersiz esik degerini reddeder", () => {
    expect(() => updateDeliveryVarianceSettings(station.id, { thresholdPct: 150 }, actor)).toThrow(DeliveryVarianceError);
    expect(() => updateDeliveryVarianceSettings(station.id, { minLiters: -1 }, actor)).toThrow(DeliveryVarianceError);
  });
});

describe("teslimat kaydi", () => {
  it("kayit stoguna FIILEN GIREN miktari yazar, irsaliyeyi degil", () => {
    // Bu satirin tamami ozelligin sebebi: irsaliye rakami yazilirsa eksik gelen yakit,
    // teslimat aninda degil sonraki gunlere yayilmis gizemli bir sapma olarak gorunur.
    const before = getTank(station.id, "motorin").current_liters;

    addStock(station.id, "motorin", 20000, { supplier: "Tedarikci A", measuredBefore: before, measuredAfter: before + 19600 }, actor);

    expect(getTank(station.id, "motorin").current_liters).toBe(before + 19600);
  });

  it("olcum yoksa eskisi gibi irsaliye miktarini ekler", () => {
    const before = getTank(station.id, "motorin").current_liters;

    addStock(station.id, "motorin", 20000, { supplier: "Tedarikci A" }, actor);

    expect(getTank(station.id, "motorin").current_liters).toBe(before + 20000);
  });

  it("eksik teslimatta kritik alarm uretir ve tedarikciyi/irsaliyeyi yazar", () => {
    addStock(
      station.id,
      "motorin",
      20000,
      { supplier: "Tedarikci A", deliveryRef: "IRS-777", measuredBefore: 0, measuredAfter: 19600 },
      actor
    );

    const alarms = activeShortDeliveryAlarms(station.id);
    expect(alarms).toHaveLength(1);
    // Itiraz ancak tanker sahadayken yapilabilir; alarm kimi arayacagini soylemeli.
    expect(alarms[0]!.message).toContain("Tedarikci A");
    expect(alarms[0]!.message).toContain("IRS-777");
    expect(alarms[0]!.message).toContain("19600");
  });

  it("tolerans icindeki teslimatta alarm uretmez", () => {
    addStock(station.id, "motorin", 20000, { supplier: "Tedarikci A", measuredBefore: 0, measuredAfter: 19920 }, actor);

    expect(activeShortDeliveryAlarms(station.id)).toHaveLength(0);
  });

  it("hareket satirina irsaliye, olcumler ve farki kaydeder", () => {
    addStock(station.id, "motorin", 20000, { supplier: "Tedarikci A", measuredBefore: 1000, measuredAfter: 20600 }, actor);

    const m = db
      .prepare<[number], { liters: number; declared_liters: number; measured_before_liters: number; delivery_variance_liters: number }>(
        "SELECT liters, declared_liters, measured_before_liters, delivery_variance_liters FROM fuel_stock_movements WHERE station_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(station.id)!;

    expect(m.liters).toBe(19600);
    expect(m.declared_liters).toBe(20000);
    expect(m.measured_before_liters).toBe(1000);
    expect(m.delivery_variance_liters).toBe(-400);
  });

  it("olculmeyen teslimatta fark alanlarini NULL birakir", () => {
    addStock(station.id, "motorin", 20000, { supplier: "Tedarikci A" }, actor);

    const m = db
      .prepare<[number], { declared_liters: number | null; delivery_variance_liters: number | null }>(
        "SELECT declared_liters, delivery_variance_liters FROM fuel_stock_movements WHERE station_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(station.id)!;

    expect(m.declared_liters).toBeNull();
    expect(m.delivery_variance_liters).toBeNull();
  });

  it("kapasite asimini FIILEN GIREN miktara gore hesaplar", () => {
    setCapacity(station.id, 10000);

    const { overflow } = addStock(
      station.id,
      "motorin",
      20000,
      { supplier: "Tedarikci A", measuredBefore: 0, measuredAfter: 19600 },
      actor
    );

    // Irsaliye 20000 olsa da tanka giren 19600'du; tasma o rakama gore hesaplanir.
    expect(overflow).toBe(9600);
    expect(getTank(station.id, "motorin").current_liters).toBe(10000);
  });
});

describe("tedarikci karnesi", () => {
  it("tedarikci basina kumulatif farki toplar", () => {
    // Tek teslimatta %0.4 tolerans icindedir ve alarm uretmez; ayni tedarikci her
    // seferinde 0.4 eksik getiriyorsa bu bir DESENDIR ve yalnizca toplamda gorunur.
    for (let i = 0; i < 3; i++) {
      addStock(station.id, "motorin", 20000, { supplier: "Surekli Eksik A.S.", measuredBefore: 0, measuredAfter: 19920 }, actor);
    }
    addStock(station.id, "motorin", 20000, { supplier: "Duzgun Petrol", measuredBefore: 0, measuredAfter: 20000 }, actor);

    const rows = getSupplierDeliveryVariance(station.id);
    const bad = rows.find((r) => r.supplier === "Surekli Eksik A.S.")!;
    const good = rows.find((r) => r.supplier === "Duzgun Petrol")!;

    expect(bad.deliveryCount).toBe(3);
    expect(bad.varianceLiters).toBe(-240);
    expect(bad.variancePct).toBe(-0.4);
    expect(good.varianceLiters).toBe(0);
    // En cok eksik veren en ustte.
    expect(rows[0]!.supplier).toBe("Surekli Eksik A.S.");
  });

  it("tasma olan teslimatta FIILEN BOSALTILAN miktari gosterir, tanka sigani degil", () => {
    // m.liters tank kapasitesiyle sinirlanmis miktardir; onu "fiilen giren" diye
    // gostermek satiri kendi kendisiyle celisir hale getirirdi.
    setCapacity(station.id, 5000);

    addStock(station.id, "motorin", 20000, { supplier: "Tedarikci A", measuredBefore: 0, measuredAfter: 19600 }, actor);

    const row = getSupplierDeliveryVariance(station.id).find((r) => r.supplier === "Tedarikci A")!;

    expect(row.declaredLiters).toBe(20000);
    expect(row.acceptedLiters).toBe(19600);
    expect(row.varianceLiters).toBe(-400);
  });

  it("olculmeyen teslimati kumulatif farka katmaz", () => {
    addStock(station.id, "motorin", 20000, { supplier: "Tedarikci A" }, actor);
    addStock(station.id, "motorin", 10000, { supplier: "Tedarikci A", measuredBefore: 0, measuredAfter: 9900 }, actor);

    const row = getSupplierDeliveryVariance(station.id).find((r) => r.supplier === "Tedarikci A")!;

    expect(row.deliveryCount).toBe(2);
    expect(row.measuredCount).toBe(1);
    expect(row.declaredLiters).toBe(10000); // yalnizca olculen teslimat
    expect(row.varianceLiters).toBe(-100);
  });

  it("tarih araligiyla filtreler", () => {
    addStock(station.id, "motorin", 20000, { supplier: "Tedarikci A", measuredBefore: 0, measuredAfter: 19000 }, actor);
    db.prepare("UPDATE fuel_stock_movements SET created_at = '2026-07-01T09:00:00.000Z' WHERE station_id = ?").run(station.id);

    expect(getSupplierDeliveryVariance(station.id, "2026-08-01", "2026-08-31")).toHaveLength(0);
    expect(getSupplierDeliveryVariance(station.id, "2026-07-01", "2026-07-31")).toHaveLength(1);
  });
});
