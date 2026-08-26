import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { createSession, listSessionsForUser, resolveSession } from "./sessionService.js";
import { verifyPassword } from "../utils/password.js";
import { PasswordResetError, requestPasswordReset, resetPasswordWithToken } from "./passwordResetService.js";
import { env } from "../config.js";

const sendEmail = vi.hoisted(() => vi.fn(async (_to: string, _subject: string, _text: string, _html?: string) => ({ sent: true })));
const sendSms = vi.hoisted(() => vi.fn(async (_to: string, _text: string) => ({ sent: true })));
vi.mock("./notificationService.js", () => ({ sendEmail, sendSms }));

/**
 * Sifre sifirlama, panele giris icin sifreyi BILMEDEN kullanilabilen tek yoldur;
 * buradaki bir acik dogrudan hesap devralmaya cikar.
 */

let station: StationRow;
let user: UserRow;

/** Gonderilen e-postadaki baglantidan ham token'i cikarir - saklanan yalnizca hash'idir. */
function sentToken(): string {
  const text = sendEmail.mock.calls.at(-1)![2];
  return /token=([A-Za-z0-9_-]+)/.exec(text)![1]!;
}

function reload(id = user.id): UserRow {
  return db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(id)!;
}

beforeEach(() => {
  sendEmail.mockClear();
  sendSms.mockClear();
  station = createTestStation();
  user = createTestUser(station.id, "admin");
  db.prepare("UPDATE users SET email = ? WHERE id = ?").run(`${user.username}@ornek.com`, user.id);
  user = reload();
});

describe("sifirlama talebi", () => {
  it("ham token veritabaninda saklanmaz, yalnizca hash'i durur", async () => {
    await requestPasswordReset(user.email!, "1.2.3.4");
    const token = sentToken();
    expect(reload().reset_token_hash).not.toBe(token);
    expect(reload().reset_token_hash).toBeTruthy();
  });

  it("olmayan kullanici icin sessizce hicbir sey yapmaz", async () => {
    // Hata dondurmek, hangi e-postalarin sistemde kayitli oldugunu sizdiran bir
    // sorgu araci olurdu.
    await expect(requestPasswordReset("yok@ornek.com", undefined)).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("pasif kullaniciya sifirlama bagi gonderilmez", async () => {
    db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(user.id);
    await requestPasswordReset(user.email!, undefined);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(reload().reset_token_hash).toBeNull();
  });

  it("bagin adresi yapilandirmadan gelir - istekten enjekte edilemez", async () => {
    // GERILEME TESTI. Onceden bagin adresi cagirandan parametre olarak aliniyordu ve
    // route orayi `req.get("host")` ile dolduruyordu: saldirgan, kurbanin kullanici
    // adiyla `Host: saldirgan.example` gonderip kurbanin e-postasina GECERLI tokeni
    // tasiyan ama kendi sunucusuna giden bir bag dusurebiliyordu - kimlik dogrulamasi
    // gerektirmeyen bir uctan hesap devralma.
    //
    // Parametre tamamen kaldirildi; bu test hem e-postadaki hem SMS'teki bagin
    // WEB_ORIGIN ile basladigini dogruluyor.
    db.prepare("UPDATE users SET phone = ? WHERE id = ?").run("+90 555 111 22 33", user.id);
    user = reload();

    await requestPasswordReset(user.email!, undefined);

    const emailText = sendEmail.mock.calls.at(-1)![2];
    const emailHtml = sendEmail.mock.calls.at(-1)![3]!;
    const smsText = sendSms.mock.calls.at(-1)![1];

    for (const body of [emailText, emailHtml, smsText]) {
      const link = /https?:\/\/[^\s"<]+\/sifre-sifirla\?token=[A-Za-z0-9_-]+/.exec(body)![0];
      expect(link.startsWith(`${env.WEB_ORIGIN}/sifre-sifirla?token=`)).toBe(true);
    }
  });

  it("yeni talep oncekini gecersiz kilar", async () => {
    await requestPasswordReset(user.email!, undefined);
    const first = sentToken();
    await requestPasswordReset(user.email!, undefined);

    expect(() => resetPasswordWithToken(first, "YeniSifre123!", undefined)).toThrow(PasswordResetError);
  });
});

describe("sifre degistirme", () => {
  async function freshToken(): Promise<string> {
    await requestPasswordReset(user.email!, undefined);
    return sentToken();
  }

  it("gecerli bag sifreyi degistirir", async () => {
    const token = await freshToken();
    resetPasswordWithToken(token, "YeniSifre123!", undefined);

    const updated = reload();
    expect(
      verifyPassword("YeniSifre123!", {
        hash: updated.password_hash,
        salt: updated.password_salt,
        iterations: updated.password_iterations,
      })
    ).toBe(true);
  });

  it("bag TEK KULLANIMLIKTIR", async () => {
    const token = await freshToken();
    resetPasswordWithToken(token, "YeniSifre123!", undefined);
    // Ayni bag e-posta kutusunda duruyor; ikinci kez calismamali.
    expect(() => resetPasswordWithToken(token, "BaskaSifre456!", undefined)).toThrow(PasswordResetError);
  });

  it("suresi dolmus bag reddedilir", async () => {
    const token = await freshToken();
    db.prepare("UPDATE users SET reset_token_expires_at = ? WHERE id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      user.id
    );
    expect(() => resetPasswordWithToken(token, "YeniSifre123!", undefined)).toThrow(PasswordResetError);
  });

  it("uydurma bag reddedilir", () => {
    expect(() => resetPasswordWithToken("uydurma-token", "YeniSifre123!", undefined)).toThrow(PasswordResetError);
    expect(() => resetPasswordWithToken("", "YeniSifre123!", undefined)).toThrow(PasswordResetError);
  });

  it("zayif sifre kabul edilmez ve mevcut sifre korunur", async () => {
    const token = await freshToken();
    const before = reload().password_hash;
    expect(() => resetPasswordWithToken(token, "123", undefined)).toThrow(PasswordResetError);
    expect(reload().password_hash).toBe(before);
  });

  it("sifre degisince TUM ACIK OTURUMLAR kapatilir", async () => {
    const a = createSession(user, undefined, undefined);
    const b = createSession(user, undefined, undefined);
    const token = await freshToken();

    resetPasswordWithToken(token, "YeniSifre123!", undefined);

    // Sifreyi ele gecirmis birinin acik oturumu, sifirlamadan sonra da yasamamali.
    expect(listSessionsForUser(user.id)).toHaveLength(0);
    expect(resolveSession(a.token)).toBeNull();
    expect(resolveSession(b.token)).toBeNull();
  });

  it("sifirlama hesap kilidini ve basarisiz deneme sayacini temizler", async () => {
    db.prepare("UPDATE users SET failed_login_attempts = 5, locked_until = ? WHERE id = ?").run(
      new Date(Date.now() + 900_000).toISOString(),
      user.id
    );
    const token = await freshToken();
    resetPasswordWithToken(token, "YeniSifre123!", undefined);

    const updated = reload();
    expect(updated.failed_login_attempts).toBe(0);
    expect(updated.locked_until).toBeNull();
    expect(updated.must_change_password).toBe(0);
  });
});
