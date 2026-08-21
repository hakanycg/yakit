import { describe, expect, it } from "vitest";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import {
  FleetError,
  addPlate,
  chargeAccount,
  createAccount,
  getAccountForPlate,
  getAvailableAmount,
  topUp,
} from "./fleetService.js";

describe("fleetService - prepaid accounts", () => {
  it("charges reduce balance, topups increase it", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "ABC Lojistik", billingType: "prepaid" }, admin);
    expect(account.balance).toBe(0);

    const topped = topUp(station.id, account.id, 1000, "ilk yukleme", admin);
    expect(topped.balance).toBe(1000);
    expect(getAvailableAmount(topped)).toBe(1000);

    const charged = chargeAccount(station.id, account.id, 300, 1);
    expect(charged.balance).toBe(700);
  });

  it("rejects a charge larger than the remaining balance", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "XYZ Nakliyat", billingType: "prepaid" }, admin);
    topUp(station.id, account.id, 100, undefined, admin);
    expect(() => chargeAccount(station.id, account.id, 150, 1)).toThrow(FleetError);
  });
});

describe("fleetService - postpaid accounts", () => {
  it("charges increase the outstanding balance, respecting the credit limit", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Filo A.S.", billingType: "postpaid", creditLimit: 500 }, admin);
    expect(getAvailableAmount(account)).toBe(500);

    const charged = chargeAccount(station.id, account.id, 300, 1);
    expect(charged.balance).toBe(300);
    expect(getAvailableAmount(charged)).toBe(200);

    expect(() => chargeAccount(station.id, account.id, 250, 2)).toThrow(FleetError);
  });

  it("a topup (invoice payment) reduces the outstanding balance", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    const account = createAccount(station.id, { companyName: "Filo B.S.", billingType: "postpaid" }, admin);
    chargeAccount(station.id, account.id, 400, 1);
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
