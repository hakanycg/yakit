import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { createAccount, addPlate } from "./fleetService.js";
import {
  FleetPortalError,
  assertAccountAccess,
  authenticatePortalUser,
  changePortalPassword,
  createOrLinkPortalUser,
  createPortalSession,
  destroyPortalSession,
  getPlateBreakdown,
  getStatement,
  listAccountsForPortalUser,
  listPortalUsersForAccount,
  resetPortalUserPassword,
  resolvePortalSession,
  setPortalUserActive,
  unlinkPortalUser,
} from "./fleetPortalService.js";

let station: StationRow;
let otherStation: StationRow;
let actor: UserRow;
let accountId: number;
let otherAccountId: number;
let seq = 0;

function uniqueEmail(): string {
  seq += 1;
  return `filo-${Date.now()}-${seq}@ornek.com`;
}

/** Bir yakit alimi + ona bagli tahsilat hareketi. Ekstre bu ikisinin birlesiminden uretilir. */
function addFill(opts: { accountId: number; stationId: number; plate: string; amount: number; liters: number; at: string }): number {
  const pumpId = createTestPump(opts.stationId);
  const transactionId = db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
          total_amount, payment_method, payment_status, status, kiosk_access_token, created_at, completed_at)
       VALUES (?, ?, ?, 'motorin', 'amount', 45, ?, ?, 'fleet', 'captured', 'completed', ?, ?, ?)`
    )
    .run(
      opts.stationId,
      pumpId,
      opts.plate,
      opts.liters,
      opts.amount,
      `tok-${Math.random().toString(16).slice(2)}`,
      opts.at,
      opts.at
    ).lastInsertRowid as number;

  db.prepare(
    `INSERT INTO fleet_movements (fleet_account_id, type, amount, balance_after, transaction_id, created_at)
     VALUES (?, 'charge', ?, 0, ?, ?)`
  ).run(opts.accountId, opts.amount, transactionId, opts.at);
  return transactionId;
}

beforeEach(() => {
  station = createTestStation();
  otherStation = createTestStation();
  actor = createTestUser(station.id, "admin");
  accountId = createAccount(station.id, { companyName: "Test Nakliyat", billingType: "prepaid" }, actor).id;
  otherAccountId = createAccount(otherStation.id, { companyName: "Baska Sirket", billingType: "prepaid" }, actor).id;
});

describe("portal kullanicisi olusturma", () => {
  it("gecici sifreyi yalnizca olusturma aninda dondurur ve o sifreyle giris yapilabilir", () => {
    const email = uniqueEmail();
    const created = createOrLinkPortalUser(station.id, accountId, { email }, actor);

    expect(created.temporaryPassword.length).toBeGreaterThan(10);
    expect(authenticatePortalUser(email, created.temporaryPassword).ok).toBe(true);
    // Gecici sifre hicbir yerde saklanmaz: kayitta yalnizca hash vardir.
    const row = db.prepare<[string], { password_hash: string }>("SELECT password_hash FROM fleet_portal_users WHERE email = ?").get(email)!;
    expect(row.password_hash).not.toContain(created.temporaryPassword);
  });

  it("ilk giriste sifre degistirmeyi zorunlu isaretler", () => {
    const created = createOrLinkPortalUser(station.id, accountId, { email: uniqueEmail() }, actor);
    expect(created.user.mustChangePassword).toBe(true);
  });

  it("ayni e-postayi ikinci bir hesaba baglar, yeni sifre uretmez", () => {
    // Bir sirket zincirin iki istasyonunda yakit aliyorsa iki AYRI hesabi olur; ona iki
    // sifre vermek anlamsiz olurdu.
    const email = uniqueEmail();
    const first = createOrLinkPortalUser(station.id, accountId, { email }, actor);
    const second = createOrLinkPortalUser(otherStation.id, otherAccountId, { email }, actor);

    expect(second.temporaryPassword).toBe("");
    expect(second.user.id).toBe(first.user.id);
    expect(listAccountsForPortalUser(first.user.id).map((a) => a.accountId).sort()).toEqual([accountId, otherAccountId].sort());
  });

  it("ayni hesaba iki kez baglamayi reddeder", () => {
    const email = uniqueEmail();
    createOrLinkPortalUser(station.id, accountId, { email }, actor);
    expect(() => createOrLinkPortalUser(station.id, accountId, { email }, actor)).toThrow(FleetPortalError);
  });

  it("baska istasyonun hesabina kullanici eklemeyi reddeder", () => {
    expect(() => createOrLinkPortalUser(station.id, otherAccountId, { email: uniqueEmail() }, actor)).toThrow();
  });
});

describe("giris", () => {
  it("var olmayan hesapla yanlis sifre ayni cevabi dondurur", () => {
    // Aksi halde portal, bir sirketin bizde hesabi olup olmadigini disariya sizdiran
    // bir sorgu araci olurdu.
    const email = uniqueEmail();
    createOrLinkPortalUser(station.id, accountId, { email }, actor);

    const wrongPassword = authenticatePortalUser(email, "yanlis-sifre");
    const noSuchUser = authenticatePortalUser(uniqueEmail(), "yanlis-sifre");

    expect(wrongPassword.status).toBe(noSuchUser.status);
    expect(wrongPassword.error).toBe(noSuchUser.error);
  });

  it("5 basarisiz denemeden sonra hesabi kilitler", () => {
    const email = uniqueEmail();
    const created = createOrLinkPortalUser(station.id, accountId, { email }, actor);
    for (let i = 0; i < 5; i++) authenticatePortalUser(email, "yanlis");

    // Dogru sifreyle bile girilemez: kilit suresi dolmadan acilmaz.
    expect(authenticatePortalUser(email, created.temporaryPassword).status).toBe(423);
  });

  it("devre disi birakilmis kullaniciyi reddeder", () => {
    const email = uniqueEmail();
    const created = createOrLinkPortalUser(station.id, accountId, { email }, actor);
    setPortalUserActive(station.id, accountId, created.user.id, false);

    expect(authenticatePortalUser(email, created.temporaryPassword).status).toBe(403);
  });
});

describe("oturum", () => {
  it("gecerli token kullaniciyi cozer, silinince cozmez", () => {
    const created = createOrLinkPortalUser(station.id, accountId, { email: uniqueEmail() }, actor);
    const session = createPortalSession(created.user.id, "127.0.0.1", "test");

    expect(resolvePortalSession(session.token)?.user.id).toBe(created.user.id);
    destroyPortalSession(session.token);
    expect(resolvePortalSession(session.token)).toBeNull();
  });

  it("hesap devre disi birakilinca acik oturum aninda duser", () => {
    // Erisim kaldirildiginda 12 saat daha gecerli kalmasi kabul edilemez.
    const created = createOrLinkPortalUser(station.id, accountId, { email: uniqueEmail() }, actor);
    const session = createPortalSession(created.user.id, undefined, undefined);

    setPortalUserActive(station.id, accountId, created.user.id, false);

    expect(resolvePortalSession(session.token)).toBeNull();
  });

  it("suresi dolmus oturumu reddeder ve satiri siler", () => {
    const created = createOrLinkPortalUser(station.id, accountId, { email: uniqueEmail() }, actor);
    const session = createPortalSession(created.user.id, undefined, undefined);
    db.prepare("UPDATE fleet_portal_sessions SET expires_at = ? WHERE portal_user_id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      created.user.id
    );

    expect(resolvePortalSession(session.token)).toBeNull();
    expect(db.prepare<[number], { c: number }>("SELECT COUNT(*) c FROM fleet_portal_sessions WHERE portal_user_id = ?").get(created.user.id)!.c).toBe(0);
  });

  it("sifre degisiminde tum oturumlar duser", () => {
    const email = uniqueEmail();
    const created = createOrLinkPortalUser(station.id, accountId, { email }, actor);
    const a = createPortalSession(created.user.id, undefined, undefined);
    const b = createPortalSession(created.user.id, undefined, undefined);

    changePortalPassword(created.user.id, created.temporaryPassword, "YeniSifre123!");

    expect(resolvePortalSession(a.token)).toBeNull();
    expect(resolvePortalSession(b.token)).toBeNull();
    expect(authenticatePortalUser(email, "YeniSifre123!").ok).toBe(true);
  });

  it("yanlis mevcut sifreyle degistirmeyi reddeder", () => {
    const created = createOrLinkPortalUser(station.id, accountId, { email: uniqueEmail() }, actor);
    expect(() => changePortalPassword(created.user.id, "yanlis", "YeniSifre123!")).toThrow(FleetPortalError);
  });

  it("sifre politikasina uymayan yeni sifreyi reddeder", () => {
    const created = createOrLinkPortalUser(station.id, accountId, { email: uniqueEmail() }, actor);
    expect(() => changePortalPassword(created.user.id, created.temporaryPassword, "kisa")).toThrow(FleetPortalError);
  });
});

describe("erisim kapsami", () => {
  it("bagli olmayan hesaba erisimi reddeder", () => {
    const created = createOrLinkPortalUser(station.id, accountId, { email: uniqueEmail() }, actor);

    expect(() => assertAccountAccess(created.user.id, accountId)).not.toThrow();
    expect(() => assertAccountAccess(created.user.id, otherAccountId)).toThrow(FleetPortalError);
  });

  it("erisilemeyen hesapla var olmayan hesap ayni cevabi dondurur", () => {
    const created = createOrLinkPortalUser(station.id, accountId, { email: uniqueEmail() }, actor);

    let inaccessible: unknown;
    let missing: unknown;
    try { assertAccountAccess(created.user.id, otherAccountId); } catch (e) { inaccessible = e; }
    try { assertAccountAccess(created.user.id, 999_999_999); } catch (e) { missing = e; }

    expect((inaccessible as FleetPortalError).status).toBe((missing as FleetPortalError).status);
    expect((inaccessible as FleetPortalError).message).toBe((missing as FleetPortalError).message);
  });

  it("bagi kaldirilan kullanici hesabi artik gormez", () => {
    const created = createOrLinkPortalUser(station.id, accountId, { email: uniqueEmail() }, actor);
    createOrLinkPortalUser(otherStation.id, otherAccountId, { email: created.user.email }, actor);

    unlinkPortalUser(station.id, accountId, created.user.id);

    expect(listAccountsForPortalUser(created.user.id).map((a) => a.accountId)).toEqual([otherAccountId]);
  });

  it("son bagi da kaldirilinca kullanici kaydi silinir", () => {
    // Hicbir hesaba bagli olmayan bir portal kullanicisi, hicbir sey goremeyen ama
    // giris yapabilen bir hesap olurdu.
    const email = uniqueEmail();
    const created = createOrLinkPortalUser(station.id, accountId, { email }, actor);

    unlinkPortalUser(station.id, accountId, created.user.id);

    expect(db.prepare<[string], { c: number }>("SELECT COUNT(*) c FROM fleet_portal_users WHERE email = ?").get(email)!.c).toBe(0);
  });

  it("istasyon personeli baska istasyonun portal kullanicisini goremez", () => {
    createOrLinkPortalUser(otherStation.id, otherAccountId, { email: uniqueEmail() }, actor);
    expect(() => listPortalUsersForAccount(station.id, otherAccountId)).toThrow();
  });

  it("sifre sifirlama acik oturumlari dusurur", () => {
    const created = createOrLinkPortalUser(station.id, accountId, { email: uniqueEmail() }, actor);
    const session = createPortalSession(created.user.id, undefined, undefined);

    const fresh = resetPortalUserPassword(station.id, accountId, created.user.id);

    expect(resolvePortalSession(session.token)).toBeNull();
    expect(authenticatePortalUser(created.user.email, fresh).ok).toBe(true);
  });
});

describe("ekstre", () => {
  it("tahsilat ve iadeyi net harcamada birbirinden duser", () => {
    addFill({ accountId, stationId: station.id, plate: "34ABC01", amount: 1000, liters: 20, at: "2026-08-10T09:00:00.000Z" });
    db.prepare(
      "INSERT INTO fleet_movements (fleet_account_id, type, amount, balance_after, created_at) VALUES (?, 'refund', 200, 0, ?)"
    ).run(accountId, "2026-08-11T09:00:00.000Z");

    const s = getStatement(accountId, "2026-08-01", "2026-08-31");

    expect(s.totals.charged).toBe(1000);
    expect(s.totals.refunded).toBe(200);
    expect(s.totals.netSpend).toBe(800);
  });

  it("yakit alimina dolum detayini ekler, bakiye yuklemesine eklemez", () => {
    addFill({ accountId, stationId: station.id, plate: "34ABC01", amount: 900, liters: 20, at: "2026-08-10T09:00:00.000Z" });
    db.prepare(
      "INSERT INTO fleet_movements (fleet_account_id, type, amount, balance_after, created_at) VALUES (?, 'topup', 5000, 5000, ?)"
    ).run(accountId, "2026-08-09T09:00:00.000Z");

    const s = getStatement(accountId, "2026-08-01", "2026-08-31");
    const charge = s.rows.find((r) => r.type === "charge")!;
    const topup = s.rows.find((r) => r.type === "topup")!;

    expect(charge.plate).toBe("34ABC01");
    expect(charge.liters).toBe(20);
    expect(topup.plate).toBeNull();
    expect(s.totals.toppedUp).toBe(5000);
  });

  it("baska hesabin hareketini gostermez", () => {
    addFill({ accountId: otherAccountId, stationId: otherStation.id, plate: "34XYZ99", amount: 5000, liters: 100, at: "2026-08-10T09:00:00.000Z" });

    expect(getStatement(accountId, "2026-08-01", "2026-08-31").rows).toHaveLength(0);
  });

  it("gece yarisindan sonraki hareketi YEREL gune sayar", () => {
    // Mutabakat/konsolide raporla ayni is gunu tanimi (UTC+3): musteri ile istasyon
    // ayni gun icin farkli rakam gormemeli.
    addFill({ accountId, stationId: station.id, plate: "34ABC01", amount: 500, liters: 10, at: "2026-08-09T22:30:00.000Z" });

    expect(getStatement(accountId, "2026-08-10", "2026-08-10").totals.charged).toBe(500);
    expect(getStatement(accountId, "2026-08-09", "2026-08-09").totals.charged).toBe(0);
  });

  it("plakaya gore filtreler", () => {
    addFill({ accountId, stationId: station.id, plate: "34ABC01", amount: 300, liters: 6, at: "2026-08-10T09:00:00.000Z" });
    addFill({ accountId, stationId: station.id, plate: "06XYZ22", amount: 700, liters: 15, at: "2026-08-10T10:00:00.000Z" });

    const s = getStatement(accountId, "2026-08-01", "2026-08-31", { plate: "34abc01" });

    expect(s.rows).toHaveLength(1);
    expect(s.totals.charged).toBe(300);
  });
});

describe("plaka bazinda ozet", () => {
  it("plaka basina litre ve tutari ayirir", () => {
    addPlate(station.id, accountId, "34ABC01");
    addPlate(station.id, accountId, "06XYZ22");
    addFill({ accountId, stationId: station.id, plate: "34ABC01", amount: 300, liters: 6, at: "2026-08-10T09:00:00.000Z" });
    addFill({ accountId, stationId: station.id, plate: "34ABC01", amount: 200, liters: 4, at: "2026-08-11T09:00:00.000Z" });
    addFill({ accountId, stationId: station.id, plate: "06XYZ22", amount: 700, liters: 15, at: "2026-08-12T09:00:00.000Z" });

    const rows = getPlateBreakdown(accountId, "2026-08-01", "2026-08-31");
    const first = rows.find((r) => r.plate === "34ABC01")!;

    expect(rows[0]!.plate).toBe("06XYZ22"); // tutara gore azalan
    expect(first.fillCount).toBe(2);
    expect(first.liters).toBe(10);
    expect(first.amount).toBe(500);
  });

  it("hic yakit almamis plakayi sifir degerlerle listeler", () => {
    // "Arac kayitli mi?" ile "bu ay kullanilmamis" ayni sey degildir.
    addPlate(station.id, accountId, "34ABC01");

    const row = getPlateBreakdown(accountId, "2026-08-01", "2026-08-31").find((r) => r.plate === "34ABC01")!;

    expect(row.fillCount).toBe(0);
    expect(row.amount).toBe(0);
    expect(row.lastFillAt).toBeNull();
  });

  it("aralik disindaki dolumu saymaz", () => {
    addPlate(station.id, accountId, "34ABC01");
    addFill({ accountId, stationId: station.id, plate: "34ABC01", amount: 900, liters: 20, at: "2026-07-01T09:00:00.000Z" });

    expect(getPlateBreakdown(accountId, "2026-08-01", "2026-08-31").find((r) => r.plate === "34ABC01")!.fillCount).toBe(0);
  });
});
