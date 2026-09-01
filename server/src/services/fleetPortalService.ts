import { createHash, randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import type { FleetAccountRow, FleetPortalSessionRow, FleetPortalUserRow, UserRow } from "../db/types.js";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../utils/password.js";
import { BUSINESS_DAY_SQL_OFFSET } from "../utils/businessDay.js";
import { normalizePlate } from "../utils/plate.js";
import { getAccountById, getAvailableAmount } from "./fleetService.js";

/**
 * Filo musteri self-servis portali.
 *
 * Bugune kadar bir filo musterisi ("30 kamyonu olan nakliye sirketi") kendi hesabini
 * hic goremiyordu: bakiyesini, hangi plakanin ne zaman ne kadar yakit aldigini
 * ogrenmek icin istasyonu telefonla aramasi gerekiyordu. Dusuk bakiye uyarisi (#94)
 * sirkete gidiyor ama sirket o uyariyla hicbir sey yapamiyordu - detayi goremedigi
 * icin "ne harcadik da bitti?" sorusunun cevabi yine istasyondaydi.
 *
 * KIMLIK AYRIMI: sirket yetkilisi personel DEGILDIR. users tablosuna bir rol olarak
 * eklenseydi, requireAuth kullanip rol kontrolu yapmayan HER uc onu kabul ederdi -
 * tek bir eksik kontrol dis bir sirkete istasyon verisi acardi. Bu yuzden portal
 * kimligi bastan asagi ayridir: ayri tablo, ayri cerez, ayri middleware
 * (bkz. middleware/fleetPortalAuth.ts). Ayni gerekce kiosk cihaz tokeni icin de
 * gecerlidir.
 *
 * KAPSAM: portal kullanicisi YALNIZCA kendisine baglanmis filo hesaplarini gorur ve
 * hicbir sey yazamaz - sifresi haric. Bakiye yukleme parayla ilgilidir ve
 * istasyonda kalir.
 */

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ABSOLUTE_MAX_MS = 12 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export class FleetPortalError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Oturum
// ---------------------------------------------------------------------------

export interface CreatedPortalSession {
  token: string;
  csrfToken: string;
}

export function createPortalSession(
  portalUserId: number,
  ip: string | undefined,
  userAgent: string | undefined
): CreatedPortalSession {
  const token = generateToken();
  const csrfToken = generateToken();
  const now = new Date();

  db.prepare(
    `INSERT INTO fleet_portal_sessions (id, portal_user_id, csrf_token, ip_address, user_agent, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    hashToken(token),
    portalUserId,
    csrfToken,
    ip ?? null,
    userAgent ?? null,
    now.toISOString(),
    new Date(now.getTime() + IDLE_TIMEOUT_MS).toISOString(),
    now.toISOString()
  );

  return { token, csrfToken };
}

export interface ResolvedPortalSession {
  user: FleetPortalUserRow;
  csrfToken: string;
}

/** Personel oturumundakiyle ayni kayan pencere: 30 dk hareketsizlik, 12 saat mutlak sinir. */
export function resolvePortalSession(token: string): ResolvedPortalSession | null {
  const id = hashToken(token);
  const session = db.prepare<[string], FleetPortalSessionRow>("SELECT * FROM fleet_portal_sessions WHERE id = ?").get(id);
  if (!session) return null;

  const now = Date.now();
  if (now > new Date(session.expires_at).getTime() || now - new Date(session.created_at).getTime() > ABSOLUTE_MAX_MS) {
    db.prepare("DELETE FROM fleet_portal_sessions WHERE id = ?").run(id);
    return null;
  }

  const user = db
    .prepare<[number], FleetPortalUserRow>("SELECT * FROM fleet_portal_users WHERE id = ?")
    .get(session.portal_user_id);
  // Hesap kapatildiginda acik oturumun da hemen dusmesi gerekir; aksi halde erisim
  // 12 saat daha surerdi.
  if (!user || !user.active) {
    db.prepare("DELETE FROM fleet_portal_sessions WHERE id = ?").run(id);
    return null;
  }

  db.prepare("UPDATE fleet_portal_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
    new Date(now).toISOString(),
    new Date(now + IDLE_TIMEOUT_MS).toISOString(),
    id
  );

  return { user, csrfToken: session.csrf_token };
}

export function destroyPortalSession(token: string): void {
  db.prepare("DELETE FROM fleet_portal_sessions WHERE id = ?").run(hashToken(token));
}

export function destroyAllPortalSessions(portalUserId: number): void {
  db.prepare("DELETE FROM fleet_portal_sessions WHERE portal_user_id = ?").run(portalUserId);
}

export function purgeExpiredPortalSessions(): void {
  db.prepare("DELETE FROM fleet_portal_sessions WHERE expires_at < ?").run(new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Giris
// ---------------------------------------------------------------------------

export interface LoginOutcome {
  ok: boolean;
  user?: FleetPortalUserRow;
  status?: number;
  error?: string;
}

/**
 * Personel girisiyle ayni savunmalar: sabit is yuku (kullanici bulunamasa da bir
 * PBKDF2 dogrulamasi yapilir) ve 5 basarisiz denemede 15 dakika kilit.
 */
export function authenticatePortalUser(email: string, password: string): LoginOutcome {
  const user = db
    .prepare<[string], FleetPortalUserRow>("SELECT * FROM fleet_portal_users WHERE email = ?")
    .get(normalizeEmail(email));

  const dummy = hashPassword("timing-safety-noop");
  const target = user
    ? { hash: user.password_hash, salt: user.password_salt, iterations: user.password_iterations }
    : dummy;
  const passwordOk = verifyPassword(password, target);

  // Var olmayan hesapla yanlis sifre ayni cevabi dondurur: aksi halde portal, bir
  // sirketin bizde hesabi olup olmadigini disariya sizdiran bir sorgu araci olurdu.
  const genericFailure: LoginOutcome = { ok: false, status: 401, error: "E-posta veya sifre hatali." };
  if (!user) return genericFailure;
  if (!user.active) return { ok: false, status: 403, error: "Hesabiniz devre disi birakilmis. Lutfen istasyonla iletisime gecin." };

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { ok: false, status: 423, error: "Hesap gecici olarak kilitlendi. Lutfen daha sonra tekrar deneyin." };
  }

  if (!passwordOk) {
    const attempts = user.failed_login_attempts + 1;
    db.prepare("UPDATE fleet_portal_users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?").run(
      attempts,
      attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null,
      user.id
    );
    return genericFailure;
  }

  db.prepare(
    "UPDATE fleet_portal_users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), user.id);

  return { ok: true, user: db.prepare<[number], FleetPortalUserRow>("SELECT * FROM fleet_portal_users WHERE id = ?").get(user.id)! };
}

export function changePortalPassword(portalUserId: number, currentPassword: string, newPassword: string): void {
  const user = db.prepare<[number], FleetPortalUserRow>("SELECT * FROM fleet_portal_users WHERE id = ?").get(portalUserId);
  if (!user) throw new FleetPortalError("Kullanici bulunamadi.", 404);

  const ok = verifyPassword(currentPassword, {
    hash: user.password_hash,
    salt: user.password_salt,
    iterations: user.password_iterations,
  });
  if (!ok) throw new FleetPortalError("Mevcut sifre hatali.", 401);

  const policyErrors = validatePasswordPolicy(newPassword);
  if (policyErrors.length > 0) throw new FleetPortalError(policyErrors.join(" "), 400);

  const hashed = hashPassword(newPassword);
  db.prepare(
    "UPDATE fleet_portal_users SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 0 WHERE id = ?"
  ).run(hashed.hash, hashed.salt, hashed.iterations, portalUserId);

  // Sifre degisince diger tum oturumlar duser: sifre degistirmenin en yaygin sebebi
  // "baskasi girmis olabilir" endisesidir ve o oturum acik kalirsa islem bir ise yaramaz.
  destroyAllPortalSessions(portalUserId);
}

// ---------------------------------------------------------------------------
// Yonetim tarafi (istasyon personeli)
// ---------------------------------------------------------------------------

export interface PortalUserSummary {
  id: number;
  email: string;
  displayName: string | null;
  active: boolean;
  mustChangePassword: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

function serializePortalUser(u: FleetPortalUserRow): PortalUserSummary {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    active: !!u.active,
    mustChangePassword: !!u.must_change_password,
    locked: !!u.locked_until && new Date(u.locked_until).getTime() > Date.now(),
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}

export function listPortalUsersForAccount(stationId: number, accountId: number): PortalUserSummary[] {
  getAccountById(stationId, accountId); // istasyon kapsami disindaki hesap icin 404 firlatir
  return db
    .prepare<[number], FleetPortalUserRow>(
      `SELECT u.* FROM fleet_portal_users u
       JOIN fleet_portal_user_accounts l ON l.portal_user_id = u.id
       WHERE l.fleet_account_id = ?
       ORDER BY u.email`
    )
    .all(accountId)
    .map(serializePortalUser);
}

/** Gecici sifre: yoneticinin okuyup sirkete iletebilmesi icin BIR KEZ dondurulur, saklanmaz. */
function generateTemporaryPassword(): string {
  // Karisik karakter yok (I/l/0/O): telefonda okunacak bir sifre icin okunabilirlik
  // guvenlikten daha kritik degil ama yanlis okunan sifre destek cagrisi demektir.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(14);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out}!7`;
}

export interface CreatedPortalUser {
  user: PortalUserSummary;
  temporaryPassword: string;
}

/**
 * Portal kullanicisi olusturur veya var olan kullaniciyi bu hesaba baglar.
 *
 * Ayni e-posta ikinci bir hesaba baglanabilir: bir sirket zincirin uc istasyonunda
 * yakit aliyorsa uc AYRI fleet_accounts kaydi vardir (hesaplar istasyon bazlidir) ve
 * sirkete uc sifre vermek anlamsiz olurdu.
 */
export function createOrLinkPortalUser(
  stationId: number,
  accountId: number,
  input: { email: string; displayName?: string },
  actor: UserRow
): CreatedPortalUser {
  getAccountById(stationId, accountId);
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new FleetPortalError("Gecerli bir e-posta adresi girin.", 400);

  const existing = db.prepare<[string], FleetPortalUserRow>("SELECT * FROM fleet_portal_users WHERE email = ?").get(email);
  if (existing) {
    const alreadyLinked = db
      .prepare<[number, number], { c: number }>(
        "SELECT COUNT(*) AS c FROM fleet_portal_user_accounts WHERE portal_user_id = ? AND fleet_account_id = ?"
      )
      .get(existing.id, accountId)!.c;
    if (alreadyLinked > 0) throw new FleetPortalError("Bu e-posta zaten bu hesaba bagli.", 409);

    db.prepare("INSERT INTO fleet_portal_user_accounts (portal_user_id, fleet_account_id) VALUES (?, ?)").run(
      existing.id,
      accountId
    );
    // Mevcut kullanicinin sifresi degistirilmez - baska bir hesapta calisan bir sifreyi
    // sifirlamak, bu istasyonun o hesaptaki erisimi bozmasi demek olurdu.
    return { user: serializePortalUser(existing), temporaryPassword: "" };
  }

  const temporaryPassword = generateTemporaryPassword();
  const hashed = hashPassword(temporaryPassword);
  const result = db
    .prepare(
      `INSERT INTO fleet_portal_users (email, display_name, password_hash, password_salt, password_iterations, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(email, input.displayName?.trim() || null, hashed.hash, hashed.salt, hashed.iterations, actor.id);

  const id = result.lastInsertRowid as number;
  db.prepare("INSERT INTO fleet_portal_user_accounts (portal_user_id, fleet_account_id) VALUES (?, ?)").run(id, accountId);

  const user = db.prepare<[number], FleetPortalUserRow>("SELECT * FROM fleet_portal_users WHERE id = ?").get(id)!;
  return { user: serializePortalUser(user), temporaryPassword };
}

/** Kullanicinin bu hesaptaki erisimini kaldirir; baska hesabi kalmadiysa kaydi da siler. */
export function unlinkPortalUser(stationId: number, accountId: number, portalUserId: number): void {
  getAccountById(stationId, accountId);
  const result = db
    .prepare("DELETE FROM fleet_portal_user_accounts WHERE portal_user_id = ? AND fleet_account_id = ?")
    .run(portalUserId, accountId);
  if (result.changes === 0) throw new FleetPortalError("Portal kullanicisi bu hesaba bagli degil.", 404);

  const remaining = db
    .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM fleet_portal_user_accounts WHERE portal_user_id = ?")
    .get(portalUserId)!.c;
  if (remaining === 0) {
    db.prepare("DELETE FROM fleet_portal_users WHERE id = ?").run(portalUserId);
  }
  // Baska hesaplari kalsa bile acik oturumlar dusurulur: bir sonraki girisinde yeni
  // erisim listesiyle baslar, kaldirilan hesabi bir daha goremez.
  destroyAllPortalSessions(portalUserId);
}

/** Sifre sifirlama: yeni gecici sifre uretir ve acik oturumlari dusurur. */
export function resetPortalUserPassword(stationId: number, accountId: number, portalUserId: number): string {
  requireLink(stationId, accountId, portalUserId);
  const temporaryPassword = generateTemporaryPassword();
  const hashed = hashPassword(temporaryPassword);
  db.prepare(
    `UPDATE fleet_portal_users
     SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 1,
         failed_login_attempts = 0, locked_until = NULL
     WHERE id = ?`
  ).run(hashed.hash, hashed.salt, hashed.iterations, portalUserId);
  destroyAllPortalSessions(portalUserId);
  return temporaryPassword;
}

export function setPortalUserActive(stationId: number, accountId: number, portalUserId: number, active: boolean): PortalUserSummary {
  requireLink(stationId, accountId, portalUserId);
  db.prepare("UPDATE fleet_portal_users SET active = ? WHERE id = ?").run(active ? 1 : 0, portalUserId);
  if (!active) destroyAllPortalSessions(portalUserId);
  return serializePortalUser(db.prepare<[number], FleetPortalUserRow>("SELECT * FROM fleet_portal_users WHERE id = ?").get(portalUserId)!);
}

/**
 * Bu istasyonun bu hesabinda gercekten bagli olan bir portal kullanicisi mi?
 *
 * Erisilemeyen ile var olmayan ayni cevabi dondurur (404): aksi halde uc, baska bir
 * istasyonun portal kullanicilarinin varligini dogrulayan bir arac olurdu.
 */
function requireLink(stationId: number, accountId: number, portalUserId: number): void {
  getAccountById(stationId, accountId);
  const link = db
    .prepare<[number, number], { portal_user_id: number }>(
      "SELECT portal_user_id FROM fleet_portal_user_accounts WHERE portal_user_id = ? AND fleet_account_id = ?"
    )
    .get(portalUserId, accountId);
  if (!link) throw new FleetPortalError("Portal kullanicisi bulunamadi.", 404);
}

// ---------------------------------------------------------------------------
// Musteri tarafi sorgulari
// ---------------------------------------------------------------------------

export interface PortalAccountView {
  accountId: number;
  companyName: string;
  stationId: number;
  stationName: string;
  billingType: "prepaid" | "postpaid";
  balance: number;
  creditLimit: number | null;
  /** Su anda harcanabilir tutar. Limitsiz postpaid hesapta null. */
  availableAmount: number | null;
  active: boolean;
  plateCount: number;
  lowBalanceThreshold: number | null;
}

export function listAccountsForPortalUser(portalUserId: number): PortalAccountView[] {
  return db
    .prepare<[number], FleetAccountRow & { station_name: string; plate_count: number }>(
      `SELECT fa.*, s.name AS station_name,
              (SELECT COUNT(*) FROM fleet_plates fp WHERE fp.fleet_account_id = fa.id) AS plate_count
       FROM fleet_accounts fa
       JOIN fleet_portal_user_accounts l ON l.fleet_account_id = fa.id
       JOIN stations s ON s.id = fa.station_id
       WHERE l.portal_user_id = ?
       ORDER BY fa.company_name, s.name`
    )
    .all(portalUserId)
    .map((a) => {
      const available = getAvailableAmount(a);
      return {
        accountId: a.id,
        companyName: a.company_name,
        stationId: a.station_id,
        stationName: a.station_name,
        billingType: a.billing_type,
        balance: a.balance,
        creditLimit: a.credit_limit,
        availableAmount: available === Number.POSITIVE_INFINITY ? null : available,
        active: !!a.active,
        plateCount: a.plate_count,
        lowBalanceThreshold: a.low_balance_threshold,
      };
    });
}

/** Portal kullanicisinin gercekten erisebildigi hesap mi? Tum musteri uclarinin TEK kapisi. */
export function assertAccountAccess(portalUserId: number, accountId: number): void {
  const link = db
    .prepare<[number, number], { portal_user_id: number }>(
      "SELECT portal_user_id FROM fleet_portal_user_accounts WHERE portal_user_id = ? AND fleet_account_id = ?"
    )
    .get(portalUserId, accountId);
  // Erisilemeyen hesapla var olmayan hesap ayni cevabi dondurur.
  if (!link) throw new FleetPortalError("Hesap bulunamadi.", 404);
}

export interface PortalStatementRow {
  id: number;
  type: "topup" | "charge" | "refund" | "adjustment";
  amount: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
  /** Yakit alimina bagli hareketlerde dolum detayi; bakiye yuklemesinde null. */
  plate: string | null;
  fuelType: string | null;
  liters: number | null;
  pricePerLiter: number | null;
}

export interface PortalStatement {
  from: string;
  to: string;
  rows: PortalStatementRow[];
  totals: {
    charged: number;
    refunded: number;
    toppedUp: number;
    /** Net harcama: tahsilat - iade. Sirketin "bu ay ne harcadik" sorusunun cevabi. */
    netSpend: number;
    liters: number;
    fillCount: number;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Ekstre, HAREKET DEFTERINDEN (fleet_movements) uretilir - islemlerden degil.
 *
 * Islemler uzerinden ayri bir "dolumlar" listesi cikarilsaydi, bakiyeyle tutmayan bir
 * tablo elde ederdik: iptal edilip iadesi yapilmis bir dolum listede gorunur ama
 * bakiyeye yansimamis olurdu. Defter neyse bakiye odur; musteriye de o gosterilir.
 */
export function getStatement(
  accountId: number,
  from: string,
  to: string,
  filters: { plate?: string; type?: string } = {}
): PortalStatement {
  // Gun siniri mutabakat/konsolide raporla AYNI tanimdir (bkz. utils/businessDay.ts):
  // musteri ile istasyon ayni gun icin farkli rakam gormemeli. Hareketlerin capasi
  // created_at'tir - islemlerdeki gibi ayrica bir completed_at yoktur.
  const clauses = ["m.fleet_account_id = ?", `date(m.created_at, '${BUSINESS_DAY_SQL_OFFSET}') BETWEEN ? AND ?`];
  const params: (string | number)[] = [accountId, from, to];

  if (filters.plate) {
    clauses.push("t.plate = ?");
    params.push(normalizePlate(filters.plate));
  }
  if (filters.type) {
    clauses.push("m.type = ?");
    params.push(filters.type);
  }

  const rows = db
    .prepare<(string | number)[], PortalStatementRow>(
      `SELECT m.id AS id, m.type AS type, m.amount AS amount, m.balance_after AS balanceAfter,
              m.note AS note, m.created_at AS createdAt,
              t.plate AS plate, t.fuel_type AS fuelType,
              t.dispensed_liters AS liters, t.price_per_liter AS pricePerLiter
       FROM fleet_movements m
       LEFT JOIN transactions t ON t.id = m.transaction_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 2000`
    )
    .all(...params);

  const charged = rows.filter((r) => r.type === "charge").reduce((n, r) => n + r.amount, 0);
  const refunded = rows.filter((r) => r.type === "refund").reduce((n, r) => n + r.amount, 0);
  const toppedUp = rows.filter((r) => r.type === "topup").reduce((n, r) => n + r.amount, 0);
  const fills = rows.filter((r) => r.type === "charge" && r.liters !== null);

  return {
    from,
    to,
    rows,
    totals: {
      charged: round2(charged),
      refunded: round2(refunded),
      toppedUp: round2(toppedUp),
      netSpend: round2(charged - refunded),
      liters: round2(fills.reduce((n, r) => n + (r.liters ?? 0), 0)),
      fillCount: fills.length,
    },
  };
}

export interface PortalPlateSummary {
  plate: string;
  fillCount: number;
  liters: number;
  amount: number;
  lastFillAt: string | null;
}

/**
 * Plaka bazinda ozet: filo musterisinin en cok sordugu sorunun ("hangi arac ne kadar
 * yakiyor?") tek ekranda cevabi. Hic yakit almamis plakalar da listelenir - "arac
 * kayitli mi?" ile "bu ay kullanilmamis" ayni sey degildir.
 */
export function getPlateBreakdown(accountId: number, from: string, to: string): PortalPlateSummary[] {
  return db
    .prepare<[number, string, string, number], PortalPlateSummary>(
      `SELECT fp.plate AS plate,
              COUNT(m.id) AS fillCount,
              COALESCE(ROUND(SUM(CASE WHEN m.id IS NOT NULL THEN t.dispensed_liters ELSE 0 END), 2), 0) AS liters,
              COALESCE(ROUND(SUM(m.amount), 2), 0) AS amount,
              MAX(m.created_at) AS lastFillAt
       FROM fleet_plates fp
       LEFT JOIN transactions t ON t.plate = fp.plate
       LEFT JOIN fleet_movements m
              ON m.transaction_id = t.id AND m.type = 'charge' AND m.fleet_account_id = ?
             AND date(m.created_at, '${BUSINESS_DAY_SQL_OFFSET}') BETWEEN ? AND ?
       WHERE fp.fleet_account_id = ?
       GROUP BY fp.plate
       ORDER BY amount DESC, fp.plate`
    )
    .all(accountId, from, to, accountId)
    .map((r) => ({ ...r, lastFillAt: r.lastFillAt ?? null }));
}
