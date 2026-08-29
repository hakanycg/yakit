import { beforeEach, describe, expect, it } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import {
  StaffAdvanceError,
  createEntry,
  deleteEntry,
  getStaffBalances,
  listEntriesPaged,
  settleEntry,
} from "./staffAdvanceService.js";

let station: StationRow;
let actor: UserRow;
let staffMember: UserRow;

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  staffMember = createTestUser(station.id, "operator");
});

describe("createEntry", () => {
  it("sifir veya negatif tutar reddedilir", () => {
    expect(() => createEntry(station.id, { userId: staffMember.id, kind: "avans", amount: 0, entryDate: "2026-01-01" }, actor)).toThrow(
      StaffAdvanceError
    );
    expect(() =>
      createEntry(station.id, { userId: staffMember.id, kind: "avans", amount: -50, entryDate: "2026-01-01" }, actor)
    ).toThrow(StaffAdvanceError);
  });

  it("var olmayan kullaniciya kayit acilamaz", () => {
    expect(() => createEntry(station.id, { userId: 999999, kind: "avans", amount: 100, entryDate: "2026-01-01" }, actor)).toThrow(
      StaffAdvanceError
    );
  });

  it("baska istasyonun kullanicisina kayit acilamaz", () => {
    const other = createTestStation();
    const otherStaff = createTestUser(other.id, "operator");
    expect(() =>
      createEntry(station.id, { userId: otherStaff.id, kind: "avans", amount: 100, entryDate: "2026-01-01" }, actor)
    ).toThrow(StaffAdvanceError);
  });
});

describe("getStaffBalances", () => {
  it("avans ve masraf ayri toplanir", () => {
    createEntry(station.id, { userId: staffMember.id, kind: "avans", amount: 500, entryDate: "2026-01-01" }, actor);
    createEntry(station.id, { userId: staffMember.id, kind: "avans", amount: 200, entryDate: "2026-01-02" }, actor);
    createEntry(station.id, { userId: staffMember.id, kind: "masraf", amount: 150, entryDate: "2026-01-03" }, actor);

    const balances = getStaffBalances(station.id);
    const row = balances.find((b) => b.userId === staffMember.id);
    expect(row).toBeDefined();
    expect(row!.openAvans).toBe(700);
    expect(row!.openMasraf).toBe(150);
  });

  it("settled kayitlar bakiyeye dahil edilmez", () => {
    const entry = createEntry(station.id, { userId: staffMember.id, kind: "avans", amount: 500, entryDate: "2026-01-01" }, actor);
    settleEntry(station.id, entry.id);

    const balances = getStaffBalances(station.id);
    expect(balances.find((b) => b.userId === staffMember.id)).toBeUndefined();
  });

  it("hicbir acik kaydi olmayan personel listede gorunmez", () => {
    expect(getStaffBalances(station.id)).toHaveLength(0);
  });
});

describe("settleEntry", () => {
  it("baska istasyonun kaydini kapatamaz", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    const otherStaff = createTestUser(other.id, "operator");
    const entry = createEntry(other.id, { userId: otherStaff.id, kind: "avans", amount: 100, entryDate: "2026-01-01" }, otherActor);
    expect(() => settleEntry(station.id, entry.id)).toThrow(StaffAdvanceError);
  });
});

describe("listEntriesPaged", () => {
  it("personel/tur/durum filtreleri calisir", () => {
    const staff2 = createTestUser(station.id, "operator");
    createEntry(station.id, { userId: staffMember.id, kind: "avans", amount: 100, entryDate: "2026-01-01" }, actor);
    createEntry(station.id, { userId: staffMember.id, kind: "masraf", amount: 50, entryDate: "2026-01-02" }, actor);
    const entry3 = createEntry(station.id, { userId: staff2.id, kind: "avans", amount: 200, entryDate: "2026-01-03" }, actor);
    settleEntry(station.id, entry3.id);

    expect(listEntriesPaged(station.id, { userId: staffMember.id }).total).toBe(2);
    expect(listEntriesPaged(station.id, { kind: "masraf" }).total).toBe(1);
    expect(listEntriesPaged(station.id, { settled: true }).total).toBe(1);
    expect(listEntriesPaged(station.id, { settled: false }).total).toBe(2);
  });

  it("tarih araligi filtresi calisir", () => {
    createEntry(station.id, { userId: staffMember.id, kind: "avans", amount: 100, entryDate: "2026-01-05" }, actor);
    createEntry(station.id, { userId: staffMember.id, kind: "avans", amount: 200, entryDate: "2026-02-15" }, actor);

    const result = listEntriesPaged(station.id, { from: "2026-02-01", to: "2026-02-28" });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.amount).toBe(200);
  });

  it("total TUM eslesenleri yansitir, sayfalama sinirlari asilamaz", () => {
    for (let i = 0; i < 5; i++) {
      createEntry(station.id, { userId: staffMember.id, kind: "avans", amount: 10 + i, entryDate: "2026-01-05" }, actor);
    }
    const page1 = listEntriesPaged(station.id, { page: 1, pageSize: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.total).toBe(5);

    const clamped = listEntriesPaged(station.id, { page: -3, pageSize: 5000 });
    expect(clamped.page).toBe(1);
    expect(clamped.pageSize).toBe(200);
  });
});

describe("deleteEntry", () => {
  it("baska istasyonun kaydini silemez", () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    const otherStaff = createTestUser(other.id, "operator");
    const entry = createEntry(other.id, { userId: otherStaff.id, kind: "avans", amount: 100, entryDate: "2026-01-01" }, otherActor);
    expect(() => deleteEntry(station.id, entry.id)).toThrow(StaffAdvanceError);
  });

  it("kaydi siler", () => {
    const entry = createEntry(station.id, { userId: staffMember.id, kind: "avans", amount: 100, entryDate: "2026-01-01" }, actor);
    deleteEntry(station.id, entry.id);
    expect(listEntriesPaged(station.id, {}).total).toBe(0);
  });
});
