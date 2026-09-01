import { describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { AlarmRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestTransaction, createTestUser } from "../test/dbFixture.js";
import {
  FleetError,
  addPlate,
  chargeAccount,
  createAccount,
  getAccountForPlate,
  getAvailableAmount,
  getExpectedFuelTypeForPlate,
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
