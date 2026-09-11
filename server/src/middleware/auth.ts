import type { NextFunction, Request, Response } from "express";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import { resolveSession } from "../services/sessionService.js";
import type { RoleName, RoleRow, UserRow } from "../db/types.js";
import { db } from "../db/index.js";
import { env } from "../config.js";
import { safeCompare } from "../utils/safeCompare.js";
import { verifyPassword } from "../utils/password.js";
import { matchTotpCounter } from "../utils/totp.js";

export const SESSION_COOKIE = "yakit_sid";
export const CSRF_COOKIE = "yakit_csrf";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
      role?: RoleRow;
      sessionToken?: string;
      csrfToken?: string;
      /** Istegin kapsandigi istasyon. super_admin/tenant_admin icin ?stationId= ile secilir, digerlerinde kendi istasyonudur. */
      stationId?: number;
      /** tenant_admin icin kullanicinin dagitim sirketi. Istasyonlar arasi uclarin filtresi budur. */
      tenantId?: number;
    }
  }
}

function getCookies(req: Request): Record<string, string | undefined> {
  const header = req.headers.cookie;
  if (!header) return {};
  return parseCookie(header);
}

export function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "strict" as const,
    path: "/",
  };
}

export function setSessionCookies(res: Response, token: string, csrfToken: string): void {
  res.setHeader("Set-Cookie", [
    serializeCookie(SESSION_COOKIE, token, { ...baseCookieOptions(), maxAge: 60 * 60 * 12 }),
    serializeCookie(CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure: env.COOKIE_SECURE,
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 12,
    }),
  ]);
}

export function clearSessionCookies(res: Response): void {
  res.setHeader("Set-Cookie", [
    serializeCookie(SESSION_COOKIE, "", { ...baseCookieOptions(), maxAge: 0 }),
    serializeCookie(CSRF_COOKIE, "", { ...baseCookieOptions(), httpOnly: false, maxAge: 0 }),
  ]);
}

/** Cerezdeki oturum tokenini cozer; gecerliyse req.user / req.role doldurulur. Zorunlu degildir. */
export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const cookies = getCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return next();

  const resolved = resolveSession(token);
  if (!resolved) return next();

  req.user = resolved.user;
  req.sessionToken = token;
  req.csrfToken = resolved.session.csrf_token;
  req.role = db.prepare<[number], RoleRow>("SELECT * FROM roles WHERE id = ?").get(resolved.user.role_id);
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !req.role) {
    res.status(401).json({ error: "Oturum gerekli. Lutfen giris yapin." });
    return;
  }
  next();
}

export function requireRole(...roles: RoleName[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.role) {
      res.status(401).json({ error: "Oturum gerekli. Lutfen giris yapin." });
      return;
    }
    // super_admin her zaman gecer: platformu isleten ekip tum istasyonlara ve yetkilere sahiptir.
    if (req.role.name === "super_admin") return next();
    if (!roles.includes(req.role.name)) {
      res.status(403).json({ error: "Bu islem icin yetkiniz yok." });
      return;
    }
    next();
  };
}

/**
 * Istegin hangi istasyona ait oldugunu belirler.
 * - super_admin: ?stationId= sorgu parametresiyle secilir (verilmezse req.stationId tanimsiz kalir).
 * - digerleri: her zaman kendi station_id'lerine sabitlenir; baska bir istasyon secemezler.
 */
function parseStationIdQuery(req: Request, res: Response): number | undefined | null {
  const raw = req.query.stationId;
  if (raw === undefined) return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Gecersiz stationId." });
    return null; // hata yaziya dokuldu
  }
  return id;
}

/**
 * Istegin hangi istasyon uzerinde calisacagini belirler.
 *
 * KIRACI IZOLASYONUNUN ZORLANDIGI TEK YER BURASIDIR. Istasyona bagli butun veri
 * (pompa, islem, alarm, stok, rapor, ayar...) rotalarda req.stationId uzerinden
 * okunuyor; dolayisiyla "bu kullanici hangi istasyona erisebilir" sorusunu burada
 * cevaplamak butun sorgulari kapsar. Istasyonlar arasi calisan uclar (ör. kiosk
 * filosu) bu akisin disinda kalir ve kendi filtresini uygulamak ZORUNDADIR -
 * bkz. tenantScope.ts.
 */
export function attachStationScope(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !req.role) return next();

  if (req.role.name === "super_admin") {
    const id = parseStationIdQuery(req, res);
    if (id === null) return;
    if (id !== undefined) req.stationId = id;
    return next();
  }

  // Dagitim sirketi yoneticisi: istasyon secebilir ama YALNIZCA kendi kiracisindan.
  if (req.role.name === "tenant_admin") {
    if (req.user.tenant_id === null) {
      // Veri butunlugu ihlali: tenant_admin'in bir kiracisi olmali.
      res.status(403).json({ error: "Hesabiniza bagli bir dagitim sirketi bulunamadi." });
      return;
    }
    req.tenantId = req.user.tenant_id;

    const id = parseStationIdQuery(req, res);
    if (id === null) return;
    if (id !== undefined) {
      const owned = db
        .prepare<[number, number], { id: number }>("SELECT id FROM stations WHERE id = ? AND tenant_id = ?")
        .get(id, req.user.tenant_id);
      if (!owned) {
        // "Bulunamadi" degil "yetkiniz yok": hangi id'lerin var oldugunu sizdirmamak icin
        // ayni cevap verilir (bkz. ayni desen requireKioskDevice'ta).
        res.status(403).json({ error: "Bu istasyon sizin dagitim sirketinize bagli degil." });
        return;
      }
      req.stationId = id;
    }
    return next();
  }

  if (req.user.station_id === null) {
    // Veri butunlugu ihlali: super_admin olmayan bir kullanicinin istasyonu olmali.
    res.status(403).json({ error: "Hesabiniza bagli bir istasyon bulunamadi." });
    return;
  }
  req.stationId = req.user.station_id;
  next();
}

export function requireStationSelected(req: Request, res: Response, next: NextFunction): void {
  if (req.stationId === undefined) {
    res.status(400).json({ error: "Bir istasyon secmelisiniz (stationId parametresi)." });
    return;
  }
  next();
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cift-gonderim (double-submit) CSRF korumasi: state degistiren istekler icin header token dogrulanir. */
/**
 * Geri alinamaz super_admin islemleri (ör. istasyon silme) icin ek dogrulama - calinmis/acik
 * birakilmis bir oturumun tek basina bu tur islemleri yapabilmesini engeller. 2FA acik
 * hesaplarda GUNCEL bir TOTP kodu (replay korumali - bkz. utils/totp.ts), acik degilse
 * mevcut sifrenin tekrar girilmesi istenir (ayni ilke: /2fa/disable). requireAuth'tan
 * SONRA, csrfProtection'dan ONCE (veya sonra, sirasi onemli degil) zincire eklenir.
 */
export function requireStepUpAuth(req: Request, res: Response, next: NextFunction): void {
  const user = req.user!;
  const body = req.body as { stepUpPassword?: unknown; stepUpTotpCode?: unknown };

  if (user.totp_enabled) {
    const code = typeof body.stepUpTotpCode === "string" ? body.stepUpTotpCode : undefined;
    const matchedCounter = code && user.totp_secret ? matchTotpCounter(user.totp_secret, code) : null;
    if (matchedCounter === null || (user.totp_last_used_counter !== null && matchedCounter <= user.totp_last_used_counter)) {
      res.status(401).json({ error: "Bu islem icin guncel bir dogrulama kodu gerekli.", requiresStepUp: "totp" });
      return;
    }
    db.prepare("UPDATE users SET totp_last_used_counter = ? WHERE id = ?").run(matchedCounter, user.id);
  } else {
    const password = typeof body.stepUpPassword === "string" ? body.stepUpPassword : undefined;
    const ok =
      !!password &&
      verifyPassword(password, { hash: user.password_hash, salt: user.password_salt, iterations: user.password_iterations });
    if (!ok) {
      res.status(401).json({ error: "Bu islem icin sifrenizi tekrar girmeniz gerekli.", requiresStepUp: "password" });
      return;
    }
  }
  next();
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.user) return next(); // requireAuth zaten 401 dondurecek

  const headerToken = req.header("x-csrf-token");
  // Karsilastirma sabit zamanli: bu dosyadaki diger sir karsilastirmalari (ve kiosk
  // cihaz tokeni) zaten safeCompare kullaniyordu, CSRF tokeni tek istisnaydi.
  if (!headerToken || !req.csrfToken || !safeCompare(req.csrfToken, headerToken)) {
    res.status(403).json({ error: "Gecersiz CSRF token." });
    return;
  }
  next();
}
