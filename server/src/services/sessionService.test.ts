import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import {
  createSession,
  destroyAllSessionsForUser,
  destroyOtherSessionsForUser,
  destroySession,
  destroySessionById,
  listSessionsForUser,
  purgeExpiredSessions,
  resolveSession,
  sessionIdForToken,
} from "./sessionService.js";

/**
 * Oturum katmani panelin GUVENLIK SINIRIDIR: buradaki bir regresyon, suresi dolmus ya
 * da baskasina ait bir tokenin kabul edilmesi demektir.
 */

let station: StationRow;
let user: UserRow;

function sessionRowOf(token: string) {
  return db.prepare<[string], { id: string; expires_at: string; created_at: string }>(
    "SELECT id, expires_at, created_at FROM sessions WHERE id = ?"
  ).get(sessionIdForToken(token));
}

function shiftSession(token: string, fields: { createdAt?: string; expiresAt?: string }): void {
  const id = sessionIdForToken(token);
  if (fields.createdAt) db.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run(fields.createdAt, id);
  if (fields.expiresAt) db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(fields.expiresAt, id);
}

beforeEach(() => {
  station = createTestStation();
  user = createTestUser(station.id, "admin");
});

describe("oturum olusturma", () => {
  it("ham token veritabaninda SAKLANMAZ, yalnizca hash'i durur", () => {
    const { token } = createSession(user, "1.2.3.4", "test-agent");
    // Token'i ham haliyle arayan bir sorgu hicbir sey bulmamali: veritabani sizsa bile
    // oturum tokenleri ele gecirilemez.
    const raw = db.prepare<[string], { id: string }>("SELECT id FROM sessions WHERE id = ?").get(token);
    expect(raw).toBeUndefined();
    expect(sessionRowOf(token)).toBeDefined();
  });

  it("her oturum benzersiz token ve CSRF tokeni alir", () => {
    const a = createSession(user, undefined, undefined);
    const b = createSession(user, undefined, undefined);
    expect(a.token).not.toBe(b.token);
    expect(a.csrfToken).not.toBe(b.csrfToken);
    // CSRF tokeni oturum tokeninden AYRI olmali: cift gonderim korumasi ancak ikisi
    // farkliysa anlam tasir.
    expect(a.csrfToken).not.toBe(a.token);
  });
});

describe("oturum dogrulama", () => {
  it("gecerli token kullaniciyi dondurur", () => {
    const { token } = createSession(user, undefined, undefined);
    expect(resolveSession(token)?.user.id).toBe(user.id);
  });

  it("bilinmeyen token reddedilir", () => {
    expect(resolveSession("uydurma-token")).toBeNull();
  });

  it("her istekte sure uzar (sliding window)", () => {
    const { token } = createSession(user, undefined, undefined);
    // Suresini biraz geriye cekip yenilenip yenilenmedigine bak.
    const soon = new Date(Date.now() + 60_000).toISOString();
    shiftSession(token, { expiresAt: soon });

    resolveSession(token);
    expect(new Date(sessionRowOf(token)!.expires_at).getTime()).toBeGreaterThan(new Date(soon).getTime());
  });

  it("suresi dolmus oturum reddedilir VE silinir", () => {
    const { token } = createSession(user, undefined, undefined);
    shiftSession(token, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    expect(resolveSession(token)).toBeNull();
    // Sadece reddetmek yetmez: satir silinmezse tablo olu oturumlarla sisip kalirdi.
    expect(sessionRowOf(token)).toBeUndefined();
  });

  it("mutlak sure dolduysa oturum uzatilamaz", () => {
    const { token } = createSession(user, undefined, undefined);
    // Suresi hala gecerli ama 13 saat once acilmis: sliding window bunu sonsuza kadar
    // uzatabilmemeli - calinmis bir token sinirsiz yasardi.
    shiftSession(token, {
      createdAt: new Date(Date.now() - 13 * 3600_000).toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    expect(resolveSession(token)).toBeNull();
  });

  it("kullanici pasife alinirsa acik oturumu aninda gecersizlesir", () => {
    const { token } = createSession(user, undefined, undefined);
    db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(user.id);
    expect(resolveSession(token)).toBeNull();
    expect(sessionRowOf(token)).toBeUndefined();
  });
});

describe("oturum kapatma", () => {
  it("cikis yapan oturum bir daha kabul edilmez", () => {
    const { token } = createSession(user, undefined, undefined);
    destroySession(token);
    expect(resolveSession(token)).toBeNull();
  });

  it("kullanici yalnizca KENDI oturumunu kapatabilir", () => {
    const other = createTestUser(station.id, "operator");
    const mine = createSession(user, undefined, undefined);
    const theirs = createSession(other, undefined, undefined);

    // Baskasinin oturum kimligini tahmin eden biri onu kapatamamali.
    expect(destroySessionById(sessionIdForToken(theirs.token), user.id)).toBe(false);
    expect(resolveSession(theirs.token)).not.toBeNull();

    expect(destroySessionById(sessionIdForToken(mine.token), user.id)).toBe(true);
  });

  it("'diger tum oturumlari kapat' mevcut oturumu birakir", () => {
    const keep = createSession(user, undefined, undefined);
    createSession(user, undefined, undefined);
    createSession(user, undefined, undefined);

    const closed = destroyOtherSessionsForUser(user.id, sessionIdForToken(keep.token));
    expect(closed).toBe(2);
    expect(listSessionsForUser(user.id)).toHaveLength(1);
    expect(resolveSession(keep.token)).not.toBeNull();
  });

  it("sifre degisiminde kullanilan toplu kapatma tum oturumlari siler", () => {
    createSession(user, undefined, undefined);
    createSession(user, undefined, undefined);
    destroyAllSessionsForUser(user.id);
    expect(listSessionsForUser(user.id)).toHaveLength(0);
  });

  it("baska kullanicinin oturumlari toplu kapatmadan etkilenmez", () => {
    const other = createTestUser(station.id, "operator");
    createSession(user, undefined, undefined);
    const theirs = createSession(other, undefined, undefined);

    destroyAllSessionsForUser(user.id);
    expect(resolveSession(theirs.token)).not.toBeNull();
  });
});

describe("temizlik", () => {
  it("suresi dolmus oturumlar toplu silinir, gecerliler kalir", () => {
    const stale = createSession(user, undefined, undefined);
    const live = createSession(user, undefined, undefined);
    shiftSession(stale.token, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    purgeExpiredSessions();
    expect(sessionRowOf(stale.token)).toBeUndefined();
    expect(sessionRowOf(live.token)).toBeDefined();
  });
});
