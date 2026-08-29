import { beforeEach, describe, expect, it } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser, setTankStock } from "../test/dbFixture.js";
import { createOrder, createSupplier, receiveOrder } from "./fuelOrderService.js";
import { SupplierLedgerError, deletePayment, getSupplierLedger, listPaymentsPaged, recordPayment } from "./supplierLedgerService.js";

let station: StationRow;
let actor: UserRow;
let supplierId: number;

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  supplierId = createSupplier(station.id, { name: "Test Tedarik" }, actor).id;
});

/** Siparis olustur + maliyetli/maliyetsiz teslim al - borc hesabinin girdisi budur. */
function receiveCostedDelivery(liters: number, unitCost: number | undefined): void {
  const order = createOrder(station.id, { fuelType: "motorin", supplierId, liters }, actor);
  setTankStock(station.id, "motorin", 0);
  receiveOrder(station.id, order.id, { liters, unitCost }, actor);
}

describe("getSupplierLedger", () => {
  it("teslim alinmamis (draft/sent) siparis borca dahil edilmez", () => {
    createOrder(station.id, { fuelType: "motorin", supplierId, liters: 1000, unitCost: 20 }, actor);
    expect(getSupplierLedger(station.id)).toHaveLength(0);
  });

  it("maliyetsiz teslimat borca dahil edilmez ama sayilir", () => {
    receiveCostedDelivery(1000, undefined);
    const ledger = getSupplierLedger(station.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.totalOwed).toBe(0);
    expect(ledger[0]!.uncostedDeliveries).toBe(1);
  });

  it("maliyetli teslimat dogru borc uretir", () => {
    receiveCostedDelivery(1000, 20);
    const ledger = getSupplierLedger(station.id);
    expect(ledger[0]!.totalOwed).toBe(20000);
    expect(ledger[0]!.balance).toBe(20000);
  });

  it("odeme yapilinca bakiye azalir", () => {
    receiveCostedDelivery(1000, 20);
    recordPayment(station.id, { supplierId, amount: 5000, paymentDate: "2026-01-10" }, actor);
    const ledger = getSupplierLedger(station.id);
    expect(ledger[0]!.totalPaid).toBe(5000);
    expect(ledger[0]!.balance).toBe(15000);
  });

  it("borc tam odenince bakiye sifir olur", () => {
    receiveCostedDelivery(1000, 20);
    recordPayment(station.id, { supplierId, amount: 20000, paymentDate: "2026-01-10" }, actor);
    expect(getSupplierLedger(station.id)[0]!.balance).toBe(0);
  });

  it("fazla odeme negatif bakiye (alacak) uretir", () => {
    receiveCostedDelivery(1000, 20);
    recordPayment(station.id, { supplierId, amount: 25000, paymentDate: "2026-01-10" }, actor);
    expect(getSupplierLedger(station.id)[0]!.balance).toBe(-5000);
  });

  it("borcu olmayan ama odeme yapilmis tedarikci de listede gorunur", () => {
    recordPayment(station.id, { supplierId, amount: 1000, paymentDate: "2026-01-10" }, actor);
    const ledger = getSupplierLedger(station.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.totalOwed).toBe(0);
    expect(ledger[0]!.balance).toBe(-1000);
  });

  it("baska istasyonun borcunu/odemesini gostermez", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    const otherSupplierId = createSupplier(other.id, { name: "Baska Tedarik" }, otherActor).id;
    const order = createOrder(other.id, { fuelType: "motorin", supplierId: otherSupplierId, liters: 1000 }, otherActor);
    setTankStock(other.id, "motorin", 0);
    receiveOrder(other.id, order.id, { liters: 1000, unitCost: 20 }, otherActor);
    recordPayment(other.id, { supplierId: otherSupplierId, amount: 100, paymentDate: "2026-01-10" }, otherActor);

    expect(getSupplierLedger(station.id)).toHaveLength(0);
  });
});

describe("recordPayment", () => {
  it("sifir veya negatif tutar reddedilir", () => {
    expect(() => recordPayment(station.id, { supplierId, amount: 0, paymentDate: "2026-01-10" }, actor)).toThrow(SupplierLedgerError);
    expect(() => recordPayment(station.id, { supplierId, amount: -10, paymentDate: "2026-01-10" }, actor)).toThrow(SupplierLedgerError);
  });

  it("var olmayan tedarikciye odeme reddedilir", () => {
    expect(() => recordPayment(station.id, { supplierId: 999999, amount: 100, paymentDate: "2026-01-10" }, actor)).toThrow(SupplierLedgerError);
  });

  it("baska istasyonun tedarikcisine odeme kaydedilemez", () => {
    const other = createTestStation();
    expect(() => recordPayment(other.id, { supplierId, amount: 100, paymentDate: "2026-01-10" }, actor)).toThrow(SupplierLedgerError);
  });
});

describe("listPaymentsPaged", () => {
  it("tedarikci filtresi calisir", () => {
    const supplier2 = createSupplier(station.id, { name: "Ikinci Tedarik" }, actor).id;
    recordPayment(station.id, { supplierId, amount: 100, paymentDate: "2026-01-05" }, actor);
    recordPayment(station.id, { supplierId: supplier2, amount: 200, paymentDate: "2026-01-05" }, actor);

    const result = listPaymentsPaged(station.id, { supplierId });
    expect(result.total).toBe(1);
    expect(result.payments[0]!.amount).toBe(100);
  });

  it("tarih araligi filtresi calisir", () => {
    recordPayment(station.id, { supplierId, amount: 100, paymentDate: "2026-01-01" }, actor);
    recordPayment(station.id, { supplierId, amount: 200, paymentDate: "2026-02-15" }, actor);

    const result = listPaymentsPaged(station.id, { from: "2026-02-01", to: "2026-02-28" });
    expect(result.total).toBe(1);
    expect(result.payments[0]!.amount).toBe(200);
  });

  it("total TUM eslesenleri yansitir, sadece o sayfayi degil", () => {
    for (let i = 0; i < 5; i++) recordPayment(station.id, { supplierId, amount: 10 + i, paymentDate: "2026-01-05" }, actor);

    const page1 = listPaymentsPaged(station.id, { page: 1, pageSize: 2 });
    expect(page1.payments).toHaveLength(2);
    expect(page1.total).toBe(5);
  });

  it("pageSize ve page sinirlarini asamaz", () => {
    recordPayment(station.id, { supplierId, amount: 100, paymentDate: "2026-01-05" }, actor);
    const result = listPaymentsPaged(station.id, { page: -3, pageSize: 5000 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(200);
  });
});

describe("deletePayment", () => {
  it("odemeyi siler", () => {
    const payment = recordPayment(station.id, { supplierId, amount: 100, paymentDate: "2026-01-05" }, actor);
    deletePayment(station.id, payment.id);
    expect(listPaymentsPaged(station.id, {}).total).toBe(0);
  });

  it("baska istasyonun odemesini silemez", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    const otherSupplierId = createSupplier(other.id, { name: "Baska Tedarik" }, otherActor).id;
    const payment = recordPayment(other.id, { supplierId: otherSupplierId, amount: 100, paymentDate: "2026-01-05" }, otherActor);
    expect(() => deletePayment(station.id, payment.id)).toThrow(SupplierLedgerError);
  });
});
