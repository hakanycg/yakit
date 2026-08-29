import { beforeEach, describe, expect, it } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import {
  CashAccountError,
  createAccount,
  deleteMovement,
  listAccountsWithBalance,
  listMovementsPaged,
  recordMovement,
  updateAccount,
} from "./cashAccountService.js";

let station: StationRow;
let actor: UserRow;

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
});

describe("createAccount", () => {
  it("kisa isim reddedilir", () => {
    expect(() => createAccount(station.id, { name: "A", kind: "bank" }, actor)).toThrow(CashAccountError);
  });

  it("ayni isimde ikinci hesap reddedilir", () => {
    createAccount(station.id, { name: "Ana Hesap", kind: "bank" }, actor);
    expect(() => createAccount(station.id, { name: "Ana Hesap", kind: "cash" }, actor)).toThrow(CashAccountError);
  });
});

describe("listAccountsWithBalance", () => {
  it("hareket olmayan yeni hesabin bakiyesi sifirdir", () => {
    createAccount(station.id, { name: "Banka", kind: "bank" }, actor);
    const accounts = listAccountsWithBalance(station.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.balance).toBe(0);
  });

  it("giris/cikis karisik hareketlerde bakiye dogru hesaplanir", () => {
    const account = createAccount(station.id, { name: "Banka", kind: "bank" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "in", amount: 1000, movementDate: "2026-01-01" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "in", amount: 500, movementDate: "2026-01-02" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "out", amount: 300, movementDate: "2026-01-03" }, actor);

    const accounts = listAccountsWithBalance(station.id);
    expect(accounts[0]!.balance).toBe(1200);
  });

  it("pasif hesap gecmis hareketi varsa yine listede gorunur", () => {
    const account = createAccount(station.id, { name: "Eski Hesap", kind: "cash" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "in", amount: 100, movementDate: "2026-01-01" }, actor);
    updateAccount(station.id, account.id, { active: false });

    const accounts = listAccountsWithBalance(station.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.active).toBe(false);
    expect(accounts[0]!.balance).toBe(100);
  });

  it("baska istasyonun hesabini/bakiyesini gostermez", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    const otherAccount = createAccount(other.id, { name: "Baska Hesap", kind: "bank" }, otherActor);
    recordMovement(other.id, { accountId: otherAccount.id, direction: "in", amount: 5000, movementDate: "2026-01-01" }, otherActor);

    expect(listAccountsWithBalance(station.id)).toHaveLength(0);
  });
});

describe("recordMovement", () => {
  it("sifir veya negatif tutar reddedilir", () => {
    const account = createAccount(station.id, { name: "Banka", kind: "bank" }, actor);
    expect(() => recordMovement(station.id, { accountId: account.id, direction: "in", amount: 0, movementDate: "2026-01-01" }, actor)).toThrow(
      CashAccountError
    );
    expect(() =>
      recordMovement(station.id, { accountId: account.id, direction: "in", amount: -10, movementDate: "2026-01-01" }, actor)
    ).toThrow(CashAccountError);
  });

  it("var olmayan hesaba hareket reddedilir", () => {
    expect(() => recordMovement(station.id, { accountId: 999999, direction: "in", amount: 100, movementDate: "2026-01-01" }, actor)).toThrow(
      CashAccountError
    );
  });

  it("baska istasyonun hesabina hareket kaydedilemez", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    const otherAccount = createAccount(other.id, { name: "Baska Hesap", kind: "bank" }, otherActor);
    expect(() =>
      recordMovement(station.id, { accountId: otherAccount.id, direction: "in", amount: 100, movementDate: "2026-01-01" }, actor)
    ).toThrow(CashAccountError);
  });
});

describe("listMovementsPaged", () => {
  it("hesap ve yon filtresi calisir", () => {
    const account1 = createAccount(station.id, { name: "Hesap A", kind: "bank" }, actor);
    const account2 = createAccount(station.id, { name: "Hesap B", kind: "cash" }, actor);
    recordMovement(station.id, { accountId: account1.id, direction: "in", amount: 100, movementDate: "2026-01-01" }, actor);
    recordMovement(station.id, { accountId: account1.id, direction: "out", amount: 50, movementDate: "2026-01-01" }, actor);
    recordMovement(station.id, { accountId: account2.id, direction: "in", amount: 200, movementDate: "2026-01-01" }, actor);

    const byAccount = listMovementsPaged(station.id, { accountId: account1.id });
    expect(byAccount.total).toBe(2);

    const byDirection = listMovementsPaged(station.id, { accountId: account1.id, direction: "in" });
    expect(byDirection.total).toBe(1);
    expect(byDirection.movements[0]!.amount).toBe(100);
  });

  it("tarih araligi filtresi calisir", () => {
    const account = createAccount(station.id, { name: "Banka", kind: "bank" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "in", amount: 100, movementDate: "2026-01-01" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "in", amount: 200, movementDate: "2026-02-15" }, actor);

    const result = listMovementsPaged(station.id, { from: "2026-02-01", to: "2026-02-28" });
    expect(result.total).toBe(1);
    expect(result.movements[0]!.amount).toBe(200);
  });

  it("total TUM eslesenleri yansitir, sadece o sayfayi degil", () => {
    const account = createAccount(station.id, { name: "Banka", kind: "bank" }, actor);
    for (let i = 0; i < 5; i++) {
      recordMovement(station.id, { accountId: account.id, direction: "in", amount: 10 + i, movementDate: "2026-01-05" }, actor);
    }

    const page1 = listMovementsPaged(station.id, { page: 1, pageSize: 2 });
    expect(page1.movements).toHaveLength(2);
    expect(page1.total).toBe(5);
  });

  it("pageSize ve page sinirlarini asamaz", () => {
    const account = createAccount(station.id, { name: "Banka", kind: "bank" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "in", amount: 100, movementDate: "2026-01-05" }, actor);

    const result = listMovementsPaged(station.id, { page: -3, pageSize: 5000 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(200);
  });
});

describe("deleteMovement", () => {
  it("hareketi siler", () => {
    const account = createAccount(station.id, { name: "Banka", kind: "bank" }, actor);
    const movement = recordMovement(station.id, { accountId: account.id, direction: "in", amount: 100, movementDate: "2026-01-05" }, actor);
    deleteMovement(station.id, movement.id);
    expect(listMovementsPaged(station.id, {}).total).toBe(0);
  });

  it("baska istasyonun hareketini silemez", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    const otherAccount = createAccount(other.id, { name: "Baska Hesap", kind: "bank" }, otherActor);
    const movement = recordMovement(other.id, { accountId: otherAccount.id, direction: "in", amount: 100, movementDate: "2026-01-05" }, otherActor);
    expect(() => deleteMovement(station.id, movement.id)).toThrow(CashAccountError);
  });
});
