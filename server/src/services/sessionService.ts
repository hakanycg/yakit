import { randomBytes, createHash } from "node:crypto";
import { db } from "../db/index.js";
import type { SessionRow, UserRow } from "../db/types.js";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 dakika hareketsizlik
const ABSOLUTE_MAX_MS = 12 * 60 * 60 * 1000; // 12 saat mutlak oturum suresi

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface CreatedSession {
  token: string;
  csrfToken: string;
  session: SessionRow;
}

export function createSession(user: UserRow, ip: string | undefined, userAgent: string | undefined): CreatedSession {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const csrfToken = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + IDLE_TIMEOUT_MS).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, csrf_token, ip_address, user_agent, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tokenHash, user.id, csrfToken, ip ?? null, userAgent ?? null, now.toISOString(), expiresAt, now.toISOString());

  const session = db.prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?").get(tokenHash)!;
  return { token, csrfToken, session };
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

/** Oturum tokenini dogrular, gecerliyse (sliding window) yeniler ve kullaniciyla birlikte dondurur. */
export function resolveSession(token: string): ResolvedSession | null {
  const tokenHash = hashToken(token);
  const session = db.prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?").get(tokenHash);
  if (!session) return null;

  const now = Date.now();
  const expiresAt = new Date(session.expires_at).getTime();
  const createdAt = new Date(session.created_at).getTime();

  if (now > expiresAt || now - createdAt > ABSOLUTE_MAX_MS) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(tokenHash);
    return null;
  }

  const user = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(session.user_id);
  if (!user || !user.active) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(tokenHash);
    return null;
  }

  const newExpiresAt = new Date(now + IDLE_TIMEOUT_MS).toISOString();
  db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
    new Date(now).toISOString(),
    newExpiresAt,
    tokenHash
  );

  return { session: { ...session, expires_at: newExpiresAt }, user };
}

export function destroySession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
}

export function destroyAllSessionsForUser(userId: number): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function purgeExpiredSessions(): void {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
}
