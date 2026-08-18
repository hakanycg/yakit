import type { NextFunction, Request, Response } from "express";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import { resolveSession } from "../services/sessionService.js";
import type { RoleRow, UserRow } from "../db/types.js";
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

export function requireRole(...roles: Array<"admin" | "operator" | "viewer">) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.role) {
      res.status(401).json({ error: "Oturum gerekli. Lutfen giris yapin." });
      return;
    }
    if (!roles.includes(req.role.name)) {
      res.status(403).json({ error: "Bu islem icin yetkiniz yok." });
      return;
    }
    next();
  };
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
