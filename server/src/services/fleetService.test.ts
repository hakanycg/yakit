import { describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { AlarmRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestTransaction, createTestUser } from "../test/dbFixture.js";
import {
  FleetError,
  addPlate,
  chargeAccount,
  checkPlateSpendingLimit,
  computeFleetDiscount,
  createAccount,
  getAccountForPlate,
  getAvailableAmount,
  getExpectedFuelTypeForPlate,
  getLastOdometerForPlate,
  getMonthlySpendingForPlate,
  setDiscountAgreement,
  setPlateSpendingLimit,
  topUp,
  updateContact,
} from "./fleetService.js";

describe("fleetService - prepaid accounts", () => {
  it("charges reduce balance, topups increase it", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "ABC Lojistik", billingType: "prepaid" }, admin);
    expect(account.balance).toBe(0);

    const topped = topUp(station.id, account.id, 1000, "ilk yukleme", admin);
    expect(topped.balance).toBe(1000);
    expect(getAvailableAmount(topped)).toBe(1000);

    const charged = chargeAccount(station.id, account.id, 300, createTestTransaction(station.id, pumpId));
    expect(charged.balance).toBe(700);
  });

  it("rejects a charge larger than the remaining balance", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "XYZ Nakliyat", billingType: "prepaid" }, admin);
    topUp(station.id, account.id, 100, undefined, admin);
    expect(() => chargeAccount(station.id, account.id, 150, createTestTransaction(station.id, pumpId))).toThrow(FleetError);
  });
});

describe("fleetService - postpaid accounts", () => {
  it("charges increase the outstanding balance, respecting the credit limit", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Filo A.S.", billingType: "postpaid", creditLimit: 500 }, admin);
    expect(getAvailableAmount(account)).toBe(500);

    const charged = chargeAccount(station.id, account.id, 300, createTestTransaction(station.id, pumpId));
    expect(charged.balance).toBe(300);
    expect(getAvailableAmount(charged)).toBe(200);

    expect(() => chargeAccount(station.id, account.id, 250, createTestTransaction(station.id, pumpId))).toThrow(FleetError);
  });

  it("a topup (invoice payment) reduces the outstanding balance", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Filo B.S.", billingType: "postpaid" }, admin);
    chargeAccount(station.id, account.id, 400, createTestTransaction(station.id, pumpId));
    const paid = topUp(station.id, account.id, 400, "fatura odemesi", admin);
    expect(paid.balance).toBe(0);
  });

  it("has unlimited available amount when no credit limit is set", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Sinirsiz Filo", billingType: "postpaid" }, admin);
    expect(getAvailableAmount(account)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("fleetService - dusuk bakiye uyarisi", () => {
  it("bakiye esigin altina dusunce bir kritik alarm uretir, tekrar dusme uyarisi tekrarlamaz", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Esik A.S.", billingType: "prepaid" }, admin);
    topUp(station.id, account.id, 1000, undefined, admin);
    updateContact(station.id, account.id, { lowBalanceThreshold: 200 });

    chargeAccount(station.id, account.id, 850, createTestTransaction(station.id, pumpId)); // 1000 -> 150, esigin altinda

    const alarms = db
      .prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?")
      .all(station.id, `fleet_low_balance_${account.id}`);
    expect(alarms.length).toBe(1);
    expect(alarms[0]!.severity).toBe("critical");

    chargeAccount(station.id, account.id, 10, createTestTransaction(station.id, pumpId)); // 150 -> 140, hala altinda ama tekrar alarm uretmemeli
    const alarmsAfter = db
      .prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?")
      .all(station.id, `fleet_low_balance_${account.id}`);
    expect(alarmsAfter.length).toBe(1);
  });

  it("bakiye esigin uzerine cikinca alarmi otomatik cozer", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Esik B.S.", billingType: "prepaid" }, admin);
    topUp(station.id, account.id, 1000, undefined, admin);
    updateContact(station.id, account.id, { lowBalanceThreshold: 200 });

    chargeAccount(station.id, account.id, 850, createTestTransaction(station.id, pumpId)); // 150, esigin altinda -> alarm
    expect(
      db.prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ? AND status = 'active'").all(station.id, `fleet_low_balance_${account.id}`).length
    ).toBe(1);

    topUp(station.id, account.id, 500, undefined, admin); // 650, esigin uzerinde -> cozulmeli
    expect(
      db.prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ? AND status = 'active'").all(station.id, `fleet_low_balance_${account.id}`).length
    ).toBe(0);
  });

  it("esik belirlenmemisse (null) hicbir alarm uretmez", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Esiksiz Filo", billingType: "prepaid" }, admin);
    topUp(station.id, account.id, 100, undefined, admin);
    chargeAccount(station.id, account.id, 99, createTestTransaction(station.id, pumpId));

    const alarms = db
      .prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?")
      .all(station.id, `fleet_low_balance_${account.id}`);
    expect(alarms.length).toBe(0);
  });

  it("postpaid hesaplarda dusuk bakiye kontrolu uygulanmaz (kavram gecerli degil)", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Postpaid Filo", billingType: "postpaid", creditLimit: 1000 }, admin);
    updateContact(station.id, account.id, { lowBalanceThreshold: 200 });
    chargeAccount(station.id, account.id, 900, createTestTransaction(station.id, pumpId));

    const alarms = db
      .prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?")
      .all(station.id, `fleet_low_balance_${account.id}`);
    expect(alarms.length).toBe(0);
  });
});

describe("fleetService - plate lookup", () => {
  it("finds the active account a plate belongs to, scoped to the station", () => {
    const station = createTestStation();
    const otherStation = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Plaka Filosu", billingType: "prepaid" }, admin);
    addPlate(station.id, account.id, "34 abc 123");

    expect(getAccountForPlate(station.id, "34 ABC 123")?.id).toBe(account.id);
    expect(getAccountForPlate(otherStation.id, "34 ABC 123")).toBeNull();
    expect(getAccountForPlate(station.id, "06 XYZ 999")).toBeNull();
  });
});

describe("fleetService - last odometer for plate", () => {
  function insertCompletedTransaction(stationId: number, pumpId: number, plate: string, odometerKm: number | null, completedAt: string): void {
    db.prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, total_amount, dispensed_liters, status, odometer_km, kiosk_access_token, created_at, completed_at)
       VALUES (?, ?, ?, 'benzin', 'amount', 44.5, 100, 10, 'completed', ?, ?, ?, ?)`
    ).run(stationId, pumpId, plate, odometerKm, `tok-${plate}-${Math.random()}`, completedAt, completedAt);
  }

  it("en son km girilen tamamlanmis dolumun km degerini doner", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    insertCompletedTransaction(station.id, pumpId, "34ODO001", 10000, "2025-01-01T10:00:00.000Z");
    insertCompletedTransaction(station.id, pumpId, "34ODO001", 10500, "2025-01-10T10:00:00.000Z");

    expect(getLastOdometerForPlate(station.id, "34ODO001")).toBe(10500);
  });

  it("km girilmeyen dolumlari yok sayar", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    insertCompletedTransaction(station.id, pumpId, "34ODO002", 20000, "2025-01-01T10:00:00.000Z");
    insertCompletedTransaction(station.id, pumpId, "34ODO002", null, "2025-01-10T10:00:00.000Z");

    expect(getLastOdometerForPlate(station.id, "34ODO002")).toBe(20000);
  });

  it("hic km kaydi yoksa null doner", () => {
    const station = createTestStation();
    expect(getLastOdometerForPlate(station.id, "34ODO003")).toBeNull();
  });

  it("baska bir istasyonun ayni plakali kaydini karistirmaz", () => {
    const station = createTestStation();
    const otherStation = createTestStation();
    const pumpId = createTestPump(otherStation.id);
    insertCompletedTransaction(otherStation.id, pumpId, "34ODO004", 30000, "2025-01-01T10:00:00.000Z");

    expect(getLastOdometerForPlate(station.id, "34ODO004")).toBeNull();
  });
});

describe("fleetService - anlasma indirimi (computeFleetDiscount/setDiscountAgreement)", () => {
  it("yuzde indirimi dogru hesaplar", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Yuzde Filo", billingType: "prepaid" }, admin);
    const updated = setDiscountAgreement(station.id, account.id, { discountType: "percent", discountValue: 10 });

    expect(computeFleetDiscount(updated, 1000)).toBe(100);
  });

  it("sabit TL indirimi totalAmount'i asamaz", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Sabit Filo", billingType: "prepaid" }, admin);
    const updated = setDiscountAgreement(station.id, account.id, { discountType: "fixed", discountValue: 500 });

    expect(computeFleetDiscount(updated, 300)).toBe(300);
    expect(computeFleetDiscount(updated, 1000)).toBe(500);
  });

  it("anlasma tanimli degilse indirim sifirdir", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Anlasmasiz Filo", billingType: "prepaid" }, admin);

    expect(computeFleetDiscount(account, 1000)).toBe(0);
  });

  it("gecersiz yuzde (>100) reddedilir", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Hatali Filo", billingType: "prepaid" }, admin);

    expect(() => setDiscountAgreement(station.id, account.id, { discountType: "percent", discountValue: 150 })).toThrow(FleetError);
  });

  it("tip secilip deger girilmezse reddedilir", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Eksik Filo", billingType: "prepaid" }, admin);

    expect(() => setDiscountAgreement(station.id, account.id, { discountType: "fixed", discountValue: null })).toThrow(FleetError);
  });

  it("null gonderilerek anlasma kaldirilabilir", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Iptal Filo", billingType: "prepaid" }, admin);
    setDiscountAgreement(station.id, account.id, { discountType: "percent", discountValue: 5 });
    const cleared = setDiscountAgreement(station.id, account.id, { discountType: null, discountValue: null });

    expect(computeFleetDiscount(cleared, 1000)).toBe(0);
  });
});

describe("fleetService - arac bazinda aylik harcama limiti", () => {
  function insertFleetCharge(stationId: number, pumpId: number, plate: string, totalAmount: number, discountAmount: number, completedAt: string): void {
    db.prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, total_amount, discount_amount, dispensed_liters, status, payment_method, kiosk_access_token, created_at, completed_at)
       VALUES (?, ?, ?, 'benzin', 'amount', 44.5, ?, ?, 10, 'completed', 'fleet', ?, ?, ?)`
    ).run(stationId, pumpId, plate, totalAmount, discountAmount, `tok-${plate}-${Math.random()}`, completedAt, completedAt);
  }

  it("limit tanimli degilse harcama kontrolu her zaman gecer", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Limitsiz Filo", billingType: "prepaid" }, admin);
    addPlate(station.id, account.id, "34LIM001");

    expect(() => checkPlateSpendingLimit(station.id, "34LIM001", 1_000_000)).not.toThrow();
  });

  it("bu ayki harcama + yeni islem limiti asarsa reddeder", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Limitli Filo", billingType: "prepaid" }, admin);
    const plate = addPlate(station.id, account.id, "34LIM002");
    setPlateSpendingLimit(station.id, account.id, plate.id, 1000);

    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString();
    insertFleetCharge(station.id, pumpId, "34LIM002", 800, 0, thisMonth);

    expect(getMonthlySpendingForPlate(station.id, "34LIM002")).toBe(800);
    expect(() => checkPlateSpendingLimit(station.id, "34LIM002", 100)).not.toThrow();
    expect(() => checkPlateSpendingLimit(station.id, "34LIM002", 300)).toThrow(FleetError);
  });

  it("indirim dusulmus NET tutar uzerinden hesaplar", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Indirimli Filo", billingType: "prepaid" }, admin);
    const plate = addPlate(station.id, account.id, "34LIM003");
    setPlateSpendingLimit(station.id, account.id, plate.id, 1000);

    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 10)).toISOString();
    insertFleetCharge(station.id, pumpId, "34LIM003", 1000, 200, thisMonth); // net 800

    expect(getMonthlySpendingForPlate(station.id, "34LIM003")).toBe(800);
  });

  it("gecen ayin harcamasini bu aya SAYMAZ", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Gecen Ay Filo", billingType: "prepaid" }, admin);
    const plate = addPlate(station.id, account.id, "34LIM004");
    setPlateSpendingLimit(station.id, account.id, plate.id, 500);

    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
    insertFleetCharge(station.id, pumpId, "34LIM004", 5000, 0, lastMonth);

    expect(getMonthlySpendingForPlate(station.id, "34LIM004")).toBe(0);
    expect(() => checkPlateSpendingLimit(station.id, "34LIM004", 500)).not.toThrow();
  });

  it("baska bir istasyonun ayni plakali harcamasini karistirmaz", () => {
    const station = createTestStation();
    const otherStation = createTestStation();
    const otherPumpId = createTestPump(otherStation.id);
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Kendi Filom", billingType: "prepaid" }, admin);
    const plate = addPlate(station.id, account.id, "34LIM005");
    setPlateSpendingLimit(station.id, account.id, plate.id, 100);

    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 5)).toISOString();
    insertFleetCharge(otherStation.id, otherPumpId, "34LIM005", 5000, 0, thisMonth);

    expect(getMonthlySpendingForPlate(station.id, "34LIM005")).toBe(0);
  });

  it("negatif/sifir limit reddedilir", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Hatali Limit Filo", billingType: "prepaid" }, admin);
    const plate = addPlate(station.id, account.id, "34LIM006");

    expect(() => setPlateSpendingLimit(station.id, account.id, plate.id, 0)).toThrow(FleetError);
    expect(() => setPlateSpendingLimit(station.id, account.id, plate.id, -50)).toThrow(FleetError);
  });

  it("null gonderilerek limit kaldirilabilir", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Kaldirilan Limit Filo", billingType: "prepaid" }, admin);
    const plate = addPlate(station.id, account.id, "34LIM007");
    setPlateSpendingLimit(station.id, account.id, plate.id, 100);
    setPlateSpendingLimit(station.id, account.id, plate.id, null);

    expect(() => checkPlateSpendingLimit(station.id, "34LIM007", 1_000_000)).not.toThrow();
  });
});

describe("fleetService - expected fuel type (yanlis yakit onleme)", () => {
  it("returns the plate's expected fuel type even with no prior transaction history", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Dizel Filo", billingType: "prepaid" }, admin);
    addPlate(station.id, account.id, "34 def 456", "motorin");

    expect(getExpectedFuelTypeForPlate(station.id, "34 DEF 456")).toBe("motorin");
  });

  it("returns null when no expected fuel type was set", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Bilinmeyen Filo", billingType: "prepaid" }, admin);
    addPlate(station.id, account.id, "06 ghi 789");

    expect(getExpectedFuelTypeForPlate(station.id, "06 GHI 789")).toBeNull();
  });

  it("does not leak an expected fuel type across stations", () => {
    const station = createTestStation();
    const otherStation = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "LPG Filo", billingType: "prepaid" }, admin);
    addPlate(station.id, account.id, "35 jkl 321", "lpg");

    expect(getExpectedFuelTypeForPlate(otherStation.id, "35 JKL 321")).toBeNull();
  });
});
