import type { NextFunction, Request, Response } from "express";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import { resolveSession } from "../services/sessionService.js";
import type { RoleName, RoleRow, UserRow } from "../db/types.js";
import { db } from "../db/index.js";
import { env } from "../config.js";

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
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.user) return next(); // requireAuth zaten 401 dondurecek

  const headerToken = req.header("x-csrf-token");
  if (!headerToken || !req.csrfToken || headerToken !== req.csrfToken) {
    res.status(403).json({ error: "Gecersiz CSRF token." });
    return;
  }
  next();
}
