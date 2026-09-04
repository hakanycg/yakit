import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser, setTankStock } from "../test/dbFixture.js";
import { DuplicateDeliveryRefError, getTank } from "./fuelStockService.js";
import {
  FuelOrderError,
  cancelOrder,
  createOrder,
  createSupplier,
  listOrders,
  listOrdersPaged,
  receiveOrder,
  sendOrder,
  startDelivery,
  suggestions,
} from "./fuelOrderService.js";

const sendEmail = vi.hoisted(() => vi.fn(async (_to: string, _subject: string, _body: string) => {}));
vi.mock("./notificationService.js", () => ({ sendEmail, sendSms: vi.fn(async () => {}) }));

let station: StationRow;
let actor: UserRow;
let supplierId: number;

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const DAY = 86_400_000;

/** Gecmise donuk satis hareketi - "kac gun yeter" hesabinin girdisi. */
function addSale(fuelType: string, liters: number, daysAgo: number): void {
  db.prepare(
    "INSERT INTO fuel_stock_movements (station_id, fuel_type, type, liters, balance_after, created_at) VALUES (?, ?, 'sale', ?, 0, ?)"
  ).run(station.id, fuelType, -liters, new Date(NOW - daysAgo * DAY).toISOString());
}

beforeEach(() => {
  sendEmail.mockClear();
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  supplierId = createSupplier(station.id, { name: "Test Dagitim", email: "siparis@tedarikci.com" }, actor).id;
});

describe("siparis onerisi", () => {
  it("kalan litre degil KAC GUN YETER hesaplanir", () => {
    setTankStock(station.id, "motorin", 3000);
    // 14 gunde 14.000 litre satis = gunde 1.000 litre.
    for (let d = 1; d <= 14; d += 1) addSale("motorin", 1000, d);

    const motorin = suggestions(station.id, NOW).find((s) => s.fuelType === "motorin")!;
    expect(motorin.dailyAverageLiters).toBe(1000);
    expect(motorin.daysOfCover).toBe(3);
  });

  it("hic satis yoksa gun tahmini yapilmaz", () => {
    setTankStock(station.id, "benzin", 5000);
    const benzin = suggestions(station.id, NOW).find((s) => s.fuelType === "benzin")!;
    expect(benzin.daysOfCover).toBeNull();
  });

  it("oneri tanki DOLDURACAK miktardir", () => {
    setTankStock(station.id, "motorin", 2500);
    const motorin = suggestions(station.id, NOW).find((s) => s.fuelType === "motorin")!;
    expect(motorin.suggestedLiters).toBe(7500); // 10.000 kapasite - 2.500 mevcut
  });

  it("yolda olan siparis oneriden dusulur - ayni eksik icin iki kez siparis onerilmez", () => {
    setTankStock(station.id, "motorin", 2000);
    createOrder(station.id, { fuelType: "motorin", supplierId, liters: 6000 }, actor);

    const motorin = suggestions(station.id, NOW).find((s) => s.fuelType === "motorin")!;
    expect(motorin.openOrderLiters).toBe(6000);
    expect(motorin.suggestedLiters).toBe(2000); // 10.000 - 2.000 - 6.000
  });

  it("teslim alinan siparis artik 'yolda' sayilmaz", () => {
    setTankStock(station.id, "motorin", 2000);
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 6000 }, actor);
    receiveOrder(station.id, order.id, { liters: 6000 }, actor);

    expect(suggestions(station.id, NOW).find((s) => s.fuelType === "motorin")!.openOrderLiters).toBe(0);
  });

  it("esigin altindaki tank acil isaretlenir", () => {
    setTankStock(station.id, "motorin", 1000); // esik 1500
    expect(suggestions(station.id, NOW).find((s) => s.fuelType === "motorin")!.urgent).toBe(true);
  });

  it("esigin ustunde ama 3 gunden az kalmissa da acildir", () => {
    setTankStock(station.id, "motorin", 2800); // esik 1500, yani "dusuk stok" degil
    for (let d = 1; d <= 14; d += 1) addSale("motorin", 1400, d); // gunde 1.400 -> 2 gun
    expect(suggestions(station.id, NOW).find((s) => s.fuelType === "motorin")!.urgent).toBe(true);
  });
});

describe("siparis yasam dongusu", () => {
  it("siparis otomatik olusmaz - oneri siparis degildir", () => {
    setTankStock(station.id, "motorin", 100);
    suggestions(station.id, NOW);
    expect(listOrders(station.id)).toHaveLength(0);
  });

  it("gonderilen siparis tedarikciye e-posta olarak gider", () => {
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    sendOrder(station.id, order.id, actor);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toBe("siparis@tedarikci.com");
  });

  it("tedarikcinin e-postasi yoksa siparis yine kaydedilir", () => {
    const noEmail = createSupplier(station.id, { name: "Telefonla Calisan" }, actor).id;
    const order = createOrder(station.id, { fuelType: "benzin", supplierId: noEmail, liters: 3000 }, actor);
    const sent = sendOrder(station.id, order.id, actor);
    expect(sent.status).toBe("sent");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("ayni siparis iki kez gonderilemez", () => {
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    sendOrder(station.id, order.id, actor);
    expect(() => sendOrder(station.id, order.id, actor)).toThrow(FuelOrderError);
  });

  it("teslim alinmis siparis iptal edilemez - yakit tanka girdi", () => {
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    receiveOrder(station.id, order.id, { liters: 5000 }, actor);
    expect(() => cancelOrder(station.id, order.id)).toThrow(FuelOrderError);
  });

  it("baska istasyonun siparisine erisilemez", () => {
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    const foreign = createTestStation();
    expect(() => cancelOrder(foreign.id, order.id)).toThrow(FuelOrderError);
  });
});

describe("startDelivery (tanker teslimati canli takip)", () => {
  it("'sent' durumundaki siparisi 'delivering'e gecirir ve baslama zamanini damgalar", () => {
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    sendOrder(station.id, order.id, actor);

    const started = startDelivery(station.id, order.id, actor);

    expect(started.status).toBe("delivering");
    expect(started.delivery_started_at).not.toBeNull();
  });

  it("'draft' durumundaki (henuz gonderilmemis) siparis icin reddedilir", () => {
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    expect(() => startDelivery(station.id, order.id, actor)).toThrow(FuelOrderError);
  });

  it("zaten 'delivering' olan siparis icin tekrar cagrilamaz", () => {
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    sendOrder(station.id, order.id, actor);
    startDelivery(station.id, order.id, actor);
    expect(() => startDelivery(station.id, order.id, actor)).toThrow(FuelOrderError);
  });

  it("'delivering' durumundaki siparis normal sekilde teslim alinabilir", () => {
    setTankStock(station.id, "motorin", 1000);
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    sendOrder(station.id, order.id, actor);
    startDelivery(station.id, order.id, actor);

    const { order: received } = receiveOrder(station.id, order.id, { liters: 5000 }, actor);

    expect(received.status).toBe("received");
  });
});

describe("teslim alma", () => {
  it("stogu artirir ve siparisi teslimat hareketine baglar", () => {
    setTankStock(station.id, "motorin", 1000);
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    const { order: received } = receiveOrder(station.id, order.id, { liters: 5000, deliveryRef: "IRS-1" }, actor);

    expect(received.status).toBe("received");
    expect(received.delivery_movement_id).not.toBeNull();
    expect(getTank(station.id, "motorin").current_liters).toBe(6000);
  });

  it("bir siparis yalnizca BIR kez teslim alinabilir - ayni tanker iki kez stoga girmez", () => {
    setTankStock(station.id, "motorin", 1000);
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    receiveOrder(station.id, order.id, { liters: 5000 }, actor);

    expect(() => receiveOrder(station.id, order.id, { liters: 5000 }, actor)).toThrow(FuelOrderError);
    expect(getTank(station.id, "motorin").current_liters).toBe(6000);
  });

  it("teslimat kabul farki mevcut yoldan aynen calisir", () => {
    setTankStock(station.id, "motorin", 1000);
    const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 5000 }, actor);
    // Irsaliyede 5.000 yaziyor ama tanka 4.800 girdi.
    const { order: received, variance } = receiveOrder(
      station.id,
      order.id,
      { liters: 5000, measuredBefore: 1000, measuredAfter: 5800 },
      actor
    );

    expect(variance.acceptedLiters).toBe(4800);
    expect(variance.varianceLiters).toBe(-200);
    // Stoga IRSALIYE degil fiilen giren miktar yazilir.
    expect(getTank(station.id, "motorin").current_liters).toBe(5800);
    expect(received.received_liters).toBe(4800);
  });

  it("irsaliye tekrari kontrolu siparis yolunda da calisir ve siparis acik kalir", () => {
    const first = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 3000 }, actor);
    receiveOrder(station.id, first.id, { liters: 3000, deliveryRef: "IRS-9" }, actor);

    const second = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 3000 }, actor);
    expect(() => receiveOrder(station.id, second.id, { liters: 3000, deliveryRef: "IRS-9" }, actor)).toThrow(
      DuplicateDeliveryRefError
    );
    // Reddedilen teslimat siparisi kapatmamali: personel duzeltip yeniden dener.
    expect(listOrders(station.id).find((o) => o.id === second.id)!.status).toBe("draft");
  });
});

describe("listOrdersPaged", () => {
  it("birden fazla durumu birlikte filtreler (status IN)", () => {
    const draft = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 1000 }, actor);
    const toCancel = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 1000 }, actor);
    cancelOrder(station.id, toCancel.id);
    setTankStock(station.id, "motorin", 0);
    const toReceive = createOrder(station.id, { fuelType: "motorin", supplierId, liters: 1000 }, actor);
    receiveOrder(station.id, toReceive.id, { liters: 1000 }, actor);

    const history = listOrdersPaged(station.id, { status: ["received", "cancelled"] });
    expect(history.orders.map((o) => o.id).sort()).toEqual([toCancel.id, toReceive.id].sort());
    expect(history.orders.some((o) => o.id === draft.id)).toBe(false);
  });

  it("baska istasyonun siparislerini gostermez", () => {
    const other = createTestStation();
    const otherSupplier = createSupplier(other.id, { name: "Baska Tedarikci" }, actor).id;
    createOrder(station.id, { fuelType: "benzin", supplierId, liters: 500 }, actor);
    createOrder(other.id, { fuelType: "benzin", supplierId: otherSupplier, liters: 500 }, actor);

    const result = listOrdersPaged(station.id, {});
    expect(result.orders).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("total TUM eslesenleri yansitir, sadece o sayfayi degil", () => {
    for (let i = 0; i < 5; i++) {
      createOrder(station.id, { fuelType: "benzin", supplierId, liters: 100 }, actor);
    }

    const page1 = listOrdersPaged(station.id, { page: 1, pageSize: 2 });
    expect(page1.orders).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page3 = listOrdersPaged(station.id, { page: 3, pageSize: 2 });
    expect(page3.orders).toHaveLength(1);
    expect(page3.total).toBe(5);
  });

  it("pageSize ve page sinirlarini asamaz", () => {
    createOrder(station.id, { fuelType: "benzin", supplierId, liters: 100 }, actor);

    const result = listOrdersPaged(station.id, { page: -3, pageSize: 5000 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(200);
  });
});
