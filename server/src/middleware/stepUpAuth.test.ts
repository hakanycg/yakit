import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { db } from "../db/index.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { hashPassword } from "../utils/password.js";
import { generateTotpCode, generateTotpSecret } from "../utils/totp.js";
import { requireStepUpAuth } from "./auth.js";
import type { UserRow } from "../db/types.js";

/**
 * Gercek geri alinamaz islemlerin (ör. istasyon silme, bkz. routes/stations.ts DELETE /:id)
 * calinmis/acik birakilmis bir oturumla tek basina yapilabilmesini onlemek icin eklenen
 * ek dogrulama katmani. Express req/res yerine kioskDevice.test.ts'teki AYNI minimal
 * taklit deseni kullanilir.
 */
function fakeReq(user: UserRow, body: Record<string, unknown>): Request {
  return { user, body } as unknown as Request;
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

describe("requireStepUpAuth", () => {
  it("2FA kapali kullanicida DOGRU sifreyi kabul eder", () => {
    const station = createTestStation();
    const password = "GecerliSifre123!";
    const { hash, salt, iterations } = hashPassword(password);
    let user = createTestUser(station.id, "super_admin");
    db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?").run(hash, salt, iterations, user.id);
    user = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(user.id)!;

    const req = fakeReq(user, { stepUpPassword: password });
    const { res, captured } = fakeRes();
    let calledNext = false;
    requireStepUpAuth(req, res, () => { calledNext = true; });

    expect(calledNext).toBe(true);
    expect(captured.status).toBeUndefined();
  });

  it("2FA kapali kullanicida YANLIS sifreyi reddeder", () => {
    const station = createTestStation();
    const { hash, salt, iterations } = hashPassword("DogruSifre123!");
    let user = createTestUser(station.id, "super_admin");
    db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?").run(hash, salt, iterations, user.id);
    user = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(user.id)!;

    const req = fakeReq(user, { stepUpPassword: "YanlisSifre" });
    const { res, captured } = fakeRes();
    let calledNext = false;
    requireStepUpAuth(req, res, () => { calledNext = true; });

    expect(calledNext).toBe(false);
    expect(captured.status).toBe(401);
  });

  it("sifre hic verilmezse reddeder (bos govde ile atlatilamaz)", () => {
    const station = createTestStation();
    const user = createTestUser(station.id, "super_admin");
    const req = fakeReq(user, {});
    const { res, captured } = fakeRes();
    let calledNext = false;
    requireStepUpAuth(req, res, () => { calledNext = true; });

    expect(calledNext).toBe(false);
    expect(captured.status).toBe(401);
  });

  it("2FA acik kullanicida GUNCEL TOTP kodunu kabul eder ve last_used_counter'i ilerletir", () => {
    const station = createTestStation();
    const secret = generateTotpSecret();
    let user = createTestUser(station.id, "super_admin");
    db.prepare("UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?").run(secret, user.id);
    user = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(user.id)!;

    const code = generateTotpCode(secret);
    const req = fakeReq(user, { stepUpTotpCode: code });
    const { res, captured } = fakeRes();
    let calledNext = false;
    requireStepUpAuth(req, res, () => { calledNext = true; });

    expect(calledNext).toBe(true);
    expect(captured.status).toBeUndefined();
    const updated = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(user.id)!;
    expect(updated.totp_last_used_counter).not.toBeNull();
  });

  it("2FA acik kullanicida AYNI TOTP kodunun tekrar kullanimini (replay) reddeder", () => {
    const station = createTestStation();
    const secret = generateTotpSecret();
    let user = createTestUser(station.id, "super_admin");
    db.prepare("UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?").run(secret, user.id);
    user = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(user.id)!;
    const code = generateTotpCode(secret);

    // Ilk kullanim basarili olmali.
    const req1 = fakeReq(user, { stepUpTotpCode: code });
    const { res: res1 } = fakeRes();
    let calledNext1 = false;
    requireStepUpAuth(req1, res1, () => { calledNext1 = true; });
    expect(calledNext1).toBe(true);

    // Ayni kod ikinci kez (guncel totp_last_used_counter ile) reddedilmeli.
    const refreshed = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(user.id)!;
    const req2 = fakeReq(refreshed, { stepUpTotpCode: code });
    const { res: res2, captured: captured2 } = fakeRes();
    let calledNext2 = false;
    requireStepUpAuth(req2, res2, () => { calledNext2 = true; });

    expect(calledNext2).toBe(false);
    expect(captured2.status).toBe(401);
  });

  it("2FA acik kullanicida gecersiz kodu reddeder", () => {
    const station = createTestStation();
    const secret = generateTotpSecret();
    let user = createTestUser(station.id, "super_admin");
    db.prepare("UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?").run(secret, user.id);
    user = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(user.id)!;

    const req = fakeReq(user, { stepUpTotpCode: "000000" });
    const { res, captured } = fakeRes();
    let calledNext = false;
    requireStepUpAuth(req, res, () => { calledNext = true; });

    expect(calledNext).toBe(false);
    expect(captured.status).toBe(401);
  });
});
