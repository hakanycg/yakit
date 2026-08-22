import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { db } from "../db/index.js";
import { createTestStation } from "../test/dbFixture.js";
import { attachKioskDevice, requireKioskDevice } from "./kioskDevice.js";

/** Express req/res yerine, middleware'in okudugu/yazdigi minimum yuzeyi taklit eder. */
function fakeReq(deviceToken?: string): Request {
  return { header: (name: string) => (name.toLowerCase() === "x-kiosk-device-token" ? deviceToken : undefined) } as unknown as Request;
}

function fakeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

function addKiosk(stationId: number): string {
  const token = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO station_kiosks (station_id, label, device_token) VALUES (?, ?, ?)").run(stationId, "Test Kiosk", token);
  return token;
}

function setRequireToken(stationId: number, required: boolean): void {
  db.prepare("UPDATE stations SET require_kiosk_token = ? WHERE id = ?").run(required ? 1 : 0, stationId);
}

describe("kiosk cihaz dogrulamasi", () => {
  it("token zorunluyken, tokensiz istegi reddeder", () => {
    const station = createTestStation();
    setRequireToken(station.id, true);

    const req = fakeReq();
    const { res, captured } = fakeRes();
    attachKioskDevice(req, res, () => {});

    expect(requireKioskDevice(req, res, station.id)).toBe(false);
    expect(captured.status).toBe(401);
  });

  it("gecerli cihaz tokeniyle gelen istegi kabul eder", () => {
    const station = createTestStation();
    setRequireToken(station.id, true);
    const token = addKiosk(station.id);

    const req = fakeReq(token);
    const { res, captured } = fakeRes();
    attachKioskDevice(req, res, () => {});

    expect(requireKioskDevice(req, res, station.id)).toBe(true);
    expect(captured.status).toBeUndefined();
  });

  it("BASKA istasyonun kiosk tokeniyle bu istasyonda islem yapilmasini engeller", () => {
    const stationA = createTestStation();
    const stationB = createTestStation();
    setRequireToken(stationB.id, true);
    const tokenA = addKiosk(stationA.id);

    const req = fakeReq(tokenA);
    const { res, captured } = fakeRes();
    attachKioskDevice(req, res, () => {});

    // A istasyonunun kiosk'u, B istasyonunun pompasina erisemez.
    expect(requireKioskDevice(req, res, stationB.id)).toBe(false);
    expect(captured.status).toBe(403);
  });

  it("gecersiz token gonderilirse, istasyon zorunlu tutmasa bile reddeder", () => {
    const station = createTestStation();
    setRequireToken(station.id, false);

    const req = fakeReq("boyle-bir-token-yok");
    const { res, captured } = fakeRes();
    let nextCalled = false;
    attachKioskDevice(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(401);
  });

  it("zorunlu degilse, tokensiz istege izin verir (eski kurulumlar bozulmasin)", () => {
    const station = createTestStation();
    setRequireToken(station.id, false);

    const req = fakeReq();
    const { res, captured } = fakeRes();
    attachKioskDevice(req, res, () => {});

    expect(requireKioskDevice(req, res, station.id)).toBe(true);
    expect(captured.status).toBeUndefined();
  });

  it("gecerli token kullanildiginda kiosk'un last_seen_at bilgisini gunceller", () => {
    const station = createTestStation();
    const token = addKiosk(station.id);

    const req = fakeReq(token);
    const { res } = fakeRes();
    attachKioskDevice(req, res, () => {});

    const row = db.prepare<[string], { last_seen_at: string | null }>("SELECT last_seen_at FROM station_kiosks WHERE device_token = ?").get(token);
    expect(row?.last_seen_at).toBeTruthy();
  });
});
