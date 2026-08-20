import { randomBytes } from "node:crypto";

/**
 * Sifresi dogru giren ama 2FA acik olan kullanicilar icin, TOTP kodu girilene kadar
 * gecerli kisa omurlu "oturum acma bekliyor" bileti. Kalici oturumdan (sessionService)
 * farkli olarak bellek-ici tutulur: bu bilet sadece login akisinin ikinci adimini
 * tamamlamak icindir, sunucu yeniden baslarsa kullanicinin sifreyi tekrar girmesi
 * yeterlidir (guvenlik acisindan bir sorun degildir).
 */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Challenge {
  userId: number;
  expiresAt: number;
  attempts: number;
}

const challenges = new Map<string, Challenge>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, c] of challenges) {
    if (c.expiresAt < now) challenges.delete(token);
  }
}

export function createTotpChallenge(userId: number): string {
  purgeExpired();
  const token = randomBytes(24).toString("base64url");
  challenges.set(token, { userId, expiresAt: Date.now() + CHALLENGE_TTL_MS, attempts: 0 });
  return token;
}

/** Bilet gecerliyse kullanici id'sini dondurur; bileti SILMEZ (basarisiz kod denemesinden sonra tekrar kullanilabilmesi icin) - basari durumunda deleteTotpChallenge cagrilmalidir. */
export function peekTotpChallenge(token: string): number | null {
  purgeExpired();
  return challenges.get(token)?.userId ?? null;
}

/** Hatali kod denemesini isaretler. Deneme hakki kalmadiysa bileti yakar ve false doner. */
export function registerFailedTotpAttempt(token: string): boolean {
  const c = challenges.get(token);
  if (!c) return false;
  c.attempts += 1;
  if (c.attempts >= MAX_ATTEMPTS) {
    challenges.delete(token);
    return false;
  }
  return true;
}

export function deleteTotpChallenge(token: string): void {
  challenges.delete(token);
}
