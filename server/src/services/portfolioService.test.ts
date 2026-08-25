import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestTenant } from "../test/dbFixture.js";
import { getPortfolioReport } from "./portfolioService.js";

let tenant: { id: number };
let otherTenant: { id: number };
let stationA: StationRow;
let stationB: StationRow;
let foreignStation: StationRow;

interface SaleInput {
  station: StationRow;
  at: string;
  amount: number;
  discount?: number;
  liters?: number;
  status?: string;
}

function addSale(i: SaleInput): void {
  const pumpId = createTestPump(i.station.id);
  db.prepare(
    `INSERT INTO transactions
       (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
        total_amount, discount_amount, payment_status, status, kiosk_access_token, created_at, completed_at)
     VALUES (?, ?, '34ABC01', 'motorin', 'amount', 45, ?, ?, ?, 'captured', ?, ?, ?, ?)`
  ).run(
    i.station.id,
    pumpId,
    i.liters ?? 10,
    i.amount,
    i.discount ?? 0,
    i.status ?? "completed",
    `tok-${Math.random().toString(16).slice(2)}`,
    i.at,
    i.at
  );
}

function scoped() {
  return getPortfolioReport({ tenantId: tenant.id }, "2026-08-01", "2026-08-31");
}

beforeEach(() => {
  tenant = createTestTenant();
  otherTenant = createTestTenant();
  stationA = createTestStation(tenant.id);
  stationB = createTestStation(tenant.id);
  foreignStation = createTestStation(otherTenant.id);
});

describe("getPortfolioReport - kiraci kapsami", () => {
  it("yalnizca kendi kiracisinin istasyonlarini toplar", () => {
    // Konsolide rapor istasyonlar arasi calisir; attachStationScope'un korumasinin
    // disindadir ve filtresini kendisi uygulamak zorundadir.
    addSale({ station: stationA, at: "2026-08-10T09:00:00.000Z", amount: 1000 });
    addSale({ station: foreignStation, at: "2026-08-10T09:00:00.000Z", amount: 9999 });

    const r = scoped();

    expect(r.stations.map((s) => s.stationId).sort()).toEqual([stationA.id, stationB.id].sort());
    expect(r.totals.revenue).toBe(1000);
  });

  it("platform yoneticisi icin kisit uygulanmaz", () => {
    addSale({ station: foreignStation, at: "2026-08-10T09:00:00.000Z", amount: 500 });

    const r = getPortfolioReport({ tenantId: null }, "2026-08-01", "2026-08-31");

    expect(r.stations.some((s) => s.stationId === foreignStation.id)).toBe(true);
  });
});

describe("getPortfolioReport - toplamlar", () => {
  it("istasyon basina ciro, indirim ve litreyi ayirir; toplami dogru hesaplar", () => {
    addSale({ station: stationA, at: "2026-08-10T09:00:00.000Z", amount: 1000, discount: 100, liters: 20 });
    addSale({ station: stationB, at: "2026-08-10T10:00:00.000Z", amount: 400, liters: 8 });

    const r = scoped();
    const a = r.stations.find((s) => s.stationId === stationA.id)!;

    expect(a.revenue).toBe(900);
    expect(a.discount).toBe(100);
    expect(a.liters).toBe(20);
    expect(r.totals.revenue).toBe(1300);
    expect(r.totals.liters).toBe(28);
    expect(r.totals.transactionCount).toBe(2);
  });

  it("ciroya gore azalan siralar", () => {
    addSale({ station: stationA, at: "2026-08-10T09:00:00.000Z", amount: 200 });
    addSale({ station: stationB, at: "2026-08-10T09:00:00.000Z", amount: 800 });

    expect(scoped().stations[0]!.stationId).toBe(stationB.id);
  });

  it("satisi olmayan istasyonu da sifir degerlerle listeler", () => {
    // Listeden dusurmek yaniltici olurdu: "istasyonum kayboldu" degil, "bu ay hic
    // satis yok" bilgisi lazim.
    addSale({ station: stationA, at: "2026-08-10T09:00:00.000Z", amount: 500 });

    const b = scoped().stations.find((s) => s.stationId === stationB.id)!;

    expect(b.transactionCount).toBe(0);
    expect(b.revenue).toBe(0);
  });

  it("tamamlanmamis islemi ciroya katmaz", () => {
    addSale({ station: stationA, at: "2026-08-10T09:00:00.000Z", amount: 1000 });
    addSale({ station: stationA, at: "2026-08-10T10:00:00.000Z", amount: 700, status: "cancelled" });

    expect(scoped().totals.revenue).toBe(1000);
  });
});

describe("getPortfolioReport - is gunu araligi", () => {
  it("gece yarisindan sonraki satisi YEREL gune sayar", () => {
    // Mutabakatla AYNI is gunu tanimi (UTC+3): iki ekranin "bugun"u ayni olmali.
    // 2026-08-10 01:30 yerel = 2026-08-09 22:30 UTC
    addSale({ station: stationA, at: "2026-08-09T22:30:00.000Z", amount: 500 });

    expect(getPortfolioReport({ tenantId: tenant.id }, "2026-08-10", "2026-08-10").totals.revenue).toBe(500);
    expect(getPortfolioReport({ tenantId: tenant.id }, "2026-08-09", "2026-08-09").totals.revenue).toBe(0);
  });

  it("aralik disindaki satisi saymaz", () => {
    addSale({ station: stationA, at: "2026-07-15T09:00:00.000Z", amount: 999 });

    expect(scoped().totals.revenue).toBe(0);
  });
});

describe("getPortfolioReport - operasyonel gostergeler", () => {
  it("acik alarm ve kritik alarm sayilarini ayirir", () => {
    db.prepare("INSERT INTO alarms (station_id, type, severity, message) VALUES (?, 'test', 'warning', 'x')").run(stationA.id);
    db.prepare("INSERT INTO alarms (station_id, type, severity, message) VALUES (?, 'test', 'critical', 'y')").run(stationA.id);
    db.prepare(
      "INSERT INTO alarms (station_id, type, severity, message, status) VALUES (?, 'test', 'critical', 'z', 'resolved')"
    ).run(stationA.id);

    const a = scoped().stations.find((s) => s.stationId === stationA.id)!;

    expect(a.activeAlarms).toBe(2);
    expect(a.criticalAlarms).toBe(1);
  });

  it("acik destek taleplerini sayar", () => {
    db.prepare("INSERT INTO support_requests (station_id, category) VALUES (?, 'dispenser')").run(stationA.id);
    db.prepare("INSERT INTO support_requests (station_id, category, status) VALUES (?, 'other', 'resolved')").run(stationA.id);

    expect(scoped().stations.find((s) => s.stationId === stationA.id)!.openSupportRequests).toBe(1);
  });

  it("aralikaki kumulatif yakit sapmasini toplar", () => {
    const ins = db.prepare(
      `INSERT INTO fuel_tank_readings
         (station_id, fuel_type, measured_liters, book_liters, variance_liters, throughput_liters, variance_pct, measured_at, source)
       VALUES (?, 'motorin', 0, 0, ?, 0, 0, ?, 'manual')`
    );
    ins.run(stationA.id, -100, "2026-08-10T09:00:00.000Z");
    ins.run(stationA.id, -50, "2026-08-11T09:00:00.000Z");
    ins.run(stationA.id, -999, "2026-07-01T09:00:00.000Z"); // aralik disi

    const a = scoped().stations.find((s) => s.stationId === stationA.id)!;

    expect(a.varianceLiters).toBe(-150);
    expect(scoped().totals.varianceLiters).toBe(-150);
  });

  it("hic olcumu olmayan istasyonda sapmayi null birakir", () => {
    // 0 yazmak "olctuk, fark yok" demek olurdu; olcum yoklugu baska bir sey.
    expect(scoped().stations.find((s) => s.stationId === stationB.id)!.varianceLiters).toBeNull();
  });

  it("pasif istasyonu listeler ama aktif sayimina katmaz", () => {
    db.prepare("UPDATE stations SET active = 0 WHERE id = ?").run(stationB.id);

    const r = scoped();

    expect(r.totals.stationCount).toBe(2);
    expect(r.totals.activeStationCount).toBe(1);
  });
});
