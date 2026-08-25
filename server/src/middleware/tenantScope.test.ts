import { beforeEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { db } from "../db/index.js";
import type { RoleRow, StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestTenant, createTestUser } from "../test/dbFixture.js";
import { attachStationScope } from "./auth.js";
import { canAccessStation, stationScopeFilter } from "./tenantScope.js";

/**
 * Kiraci izolasyonu testleri.
 *
 * Bu izolasyonun zorlandigi yer attachStationScope'tur: istasyona bagli tum veri
 * req.stationId uzerinden aktigi icin "hangi istasyona erisilebilir" sorusunu orada
 * cevaplamak butun sorgulari kapsar. Istasyonlar arasi calisan uclar bu akisin
 * disinda kalir ve stationScopeFilter/canAccessStation kullanmak zorundadir.
 */

function roleOf(user: UserRow): RoleRow {
  return db.prepare<[number], RoleRow>("SELECT * FROM roles WHERE id = ?").get(user.role_id)!;
}

/** attachStationScope'u gercek Express nesneleri olmadan calistirir. */
function runScope(user: UserRow, query: Record<string, string> = {}) {
  const req = { user, role: roleOf(user), query } as unknown as Request;
  let status: number | null = null;
  let body: unknown = null;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  let passed = false;
  attachStationScope(req, res, () => {
    passed = true;
  });
  return { passed, status, body, stationId: req.stationId, tenantId: req.tenantId };
}

let tenantA: { id: number };
let tenantB: { id: number };
let stationA: StationRow;
let stationB: StationRow;
let orphanStation: StationRow;

beforeEach(() => {
  tenantA = createTestTenant();
  tenantB = createTestTenant();
  stationA = createTestStation(tenantA.id);
  stationB = createTestStation(tenantB.id);
  orphanStation = createTestStation(null); // platformun kendi istasyonu
});

describe("attachStationScope - kiraci izolasyonu", () => {
  it("dagitim sirketi yoneticisi kendi istasyonunu secebilir", () => {
    const user = createTestUser(null, "tenant_admin", tenantA.id);

    const r = runScope(user, { stationId: String(stationA.id) });

    expect(r.passed).toBe(true);
    expect(r.stationId).toBe(stationA.id);
    expect(r.tenantId).toBe(tenantA.id);
  });

  it("BASKA kiracinin istasyonunu secmeyi reddeder", () => {
    // Izolasyonun asil sinandigi yer: A'nin yoneticisi B'nin verisine ulasamamali.
    const user = createTestUser(null, "tenant_admin", tenantA.id);

    const r = runScope(user, { stationId: String(stationB.id) });

    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });

  it("kiraciya bagli olmayan (platform) istasyonu secmeyi reddeder", () => {
    const user = createTestUser(null, "tenant_admin", tenantA.id);

    const r = runScope(user, { stationId: String(orphanStation.id) });

    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });

  it("var olmayan istasyon icin de ayni 403'u dondurur", () => {
    // "Bulunamadi" demek, hangi id'lerin var oldugunu sizdirirdi.
    const user = createTestUser(null, "tenant_admin", tenantA.id);

    const r = runScope(user, { stationId: "99999999" });

    expect(r.status).toBe(403);
  });

  it("kiracisi olmayan tenant_admin'i reddeder (veri butunlugu ihlali)", () => {
    const user = createTestUser(null, "tenant_admin", null);

    const r = runScope(user, { stationId: String(stationA.id) });

    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });

  it("platform yoneticisi her istasyonu secebilir", () => {
    const user = createTestUser(null, "super_admin");

    expect(runScope(user, { stationId: String(stationA.id) }).stationId).toBe(stationA.id);
    expect(runScope(user, { stationId: String(stationB.id) }).stationId).toBe(stationB.id);
    expect(runScope(user, { stationId: String(orphanStation.id) }).stationId).toBe(orphanStation.id);
  });

  it("istasyon rolleri kendi istasyonuna sabitlenir, secim yapamaz", () => {
    const user = createTestUser(stationA.id, "admin");

    // Baska bir istasyon istese bile kendi istasyonuna sabitlenir.
    const r = runScope(user, { stationId: String(stationB.id) });

    expect(r.passed).toBe(true);
    expect(r.stationId).toBe(stationA.id);
  });

  it("gecersiz stationId'yi reddeder", () => {
    const user = createTestUser(null, "tenant_admin", tenantA.id);

    expect(runScope(user, { stationId: "abc" }).status).toBe(400);
    expect(runScope(user, { stationId: "-1" }).status).toBe(400);
  });
});

describe("stationScopeFilter", () => {
  it("dagitim sirketi yoneticisi icin kiraci kisiti uretir", () => {
    const user = createTestUser(null, "tenant_admin", tenantA.id);
    const req = { user, role: roleOf(user) } as unknown as Request;

    const scope = stationScopeFilter(req, "station_id");
    const rows = db
      .prepare<number[], { id: number }>(`SELECT id FROM stations WHERE ${scope.sql.replace("station_id", "id")}`)
      .all(...scope.params);

    expect(rows.map((r) => r.id)).toEqual([stationA.id]);
  });

  it("platform yoneticisi icin kisit uretmez", () => {
    const user = createTestUser(null, "super_admin");
    const req = { user, role: roleOf(user) } as unknown as Request;

    expect(stationScopeFilter(req).sql).toBe("1 = 1");
    expect(stationScopeFilter(req).params).toEqual([]);
  });
});

describe("canAccessStation", () => {
  it("kiraci yoneticisi yalnizca kendi istasyonlarina erisir", () => {
    const user = createTestUser(null, "tenant_admin", tenantA.id);
    const req = { user, role: roleOf(user) } as unknown as Request;

    expect(canAccessStation(req, stationA.id)).toBe(true);
    expect(canAccessStation(req, stationB.id)).toBe(false);
    expect(canAccessStation(req, orphanStation.id)).toBe(false);
  });

  it("platform yoneticisi hepsine erisir", () => {
    const user = createTestUser(null, "super_admin");
    const req = { user, role: roleOf(user) } as unknown as Request;

    expect(canAccessStation(req, stationA.id)).toBe(true);
    expect(canAccessStation(req, stationB.id)).toBe(true);
  });

  it("istasyon kullanicisi yalnizca kendi istasyonuna erisir", () => {
    const user = createTestUser(stationA.id, "admin");
    const req = { user, role: roleOf(user) } as unknown as Request;

    expect(canAccessStation(req, stationA.id)).toBe(true);
    expect(canAccessStation(req, stationB.id)).toBe(false);
  });

  it("istasyon kiracidan cikarilinca erisim kesilir", () => {
    const user = createTestUser(null, "tenant_admin", tenantA.id);
    const req = { user, role: roleOf(user) } as unknown as Request;
    expect(canAccessStation(req, stationA.id)).toBe(true);

    db.prepare("UPDATE stations SET tenant_id = NULL WHERE id = ?").run(stationA.id);

    expect(canAccessStation(req, stationA.id)).toBe(false);
  });
});
