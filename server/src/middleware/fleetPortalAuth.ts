import type { NextFunction, Request, Response } from "express";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import { env } from "../config.js";
import type { FleetPortalUserRow } from "../db/types.js";
import { resolvePortalSession } from "../services/fleetPortalService.js";
import { safeCompare } from "../utils/safeCompare.js";

/**
 * Filo musteri portalinin kimlik dogrulamasi - personel oturumundan TAMAMEN ayridir.
 *
 * Cerez adlari da ayridir (yakit_fleet_sid / yakit_fleet_csrf). Ayni ad kullanilsaydi
 * bir tarayicida hem personel hem musteri oturumu acilamazdi ve daha kotusu, iki farkli
 * kimlik ayni cerez uzerinden birbirine karisabilirdi.
 *
 * Kapsam kontrolu TEK YERDE: butun musteri uclari req.fleetPortalUser uzerinden gecer
 * ve hangi hesaplara erisebildigi fleet_portal_user_accounts ile belirlenir
 * (bkz. assertAccountAccess). attachStationScope'un personel tarafinda oynadigi rolun
 * aynisi.
 */

export const FLEET_SESSION_COOKIE = "yakit_fleet_sid";
export const FLEET_CSRF_COOKIE = "yakit_fleet_csrf";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      fleetPortalUser?: FleetPortalUserRow;
      fleetPortalToken?: string;
      fleetPortalCsrf?: string;
    }
  }
}

function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "strict" as const,
    path: "/",
  };
}

export function setFleetPortalCookies(res: Response, token: string, csrfToken: string): void {
  res.setHeader("Set-Cookie", [
    serializeCookie(FLEET_SESSION_COOKIE, token, { ...baseCookieOptions(), maxAge: 60 * 60 * 12 }),
    serializeCookie(FLEET_CSRF_COOKIE, csrfToken, {
      httpOnly: false, // cift gonderim (double submit) icin JavaScript'in okuyabilmesi gerekir
      secure: env.COOKIE_SECURE,
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 12,
    }),
  ]);
}

export function clearFleetPortalCookies(res: Response): void {
  res.setHeader("Set-Cookie", [
    serializeCookie(FLEET_SESSION_COOKIE, "", { ...baseCookieOptions(), maxAge: 0 }),
    serializeCookie(FLEET_CSRF_COOKIE, "", { ...baseCookieOptions(), httpOnly: false, maxAge: 0 }),
  ]);
}

function getCookies(req: Request): Record<string, string | undefined> {
  const header = req.headers.cookie;
  return header ? parseCookie(header) : {};
}

export function attachFleetPortalSession(req: Request, _res: Response, next: NextFunction): void {
  const token = getCookies(req)[FLEET_SESSION_COOKIE];
  if (!token) return next();

  const resolved = resolvePortalSession(token);
  if (!resolved) return next();

  req.fleetPortalUser = resolved.user;
  req.fleetPortalToken = token;
  req.fleetPortalCsrf = resolved.csrfToken;
  next();
}

export function requireFleetPortalAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.fleetPortalUser) {
    res.status(401).json({ error: "Oturum gerekli. Lutfen giris yapin." });
    return;
  }
  next();
}

/** Cift gonderimli CSRF: cerezdeki deger, JavaScript'in basliga koydugu degerle eslesmeli. */
export function fleetPortalCsrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  const header = req.header("x-csrf-token");
  // Sabit zamanli karsilastirma - personel tarafindaki csrfProtection ile ayni.
  if (!req.fleetPortalCsrf || !header || !safeCompare(req.fleetPortalCsrf, header)) {
    res.status(403).json({ error: "Gecersiz veya eksik CSRF tokeni." });
    return;
  }
  next();
}
