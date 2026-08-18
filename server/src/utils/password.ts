import { randomBytes, pbkdf2Sync, timingSafeEqual } from "node:crypto";

const ITERATIONS = 210_000;
const KEY_LENGTH = 64;
const DIGEST = "sha512";

export interface HashedPassword {
  hash: string;
  salt: string;
  iterations: number;
}

/** Sifreyi PBKDF2-SHA512 ile, kullaniciya ozel rastgele tuz kullanarak hash'ler. */
export function hashPassword(password: string): HashedPassword {
  const salt = randomBytes(32).toString("hex");
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString("hex");
  return { hash, salt, iterations: ITERATIONS };
}

/** Zamanlama saldirilarina karsi sabit-zamanli karsilastirma ile sifre dogrulama. */
export function verifyPassword(password: string, stored: HashedPassword): boolean {
  const candidate = pbkdf2Sync(password, stored.salt, stored.iterations, KEY_LENGTH, DIGEST);
  const expected = Buffer.from(stored.hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

const PASSWORD_POLICY = {
  minLength: 10,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSpecial: true,
};

/** Guclu sifre politikasini dogrular; hata mesajlarini diziler halinde dondurur. */
export function validatePasswordPolicy(password: string): string[] {
  const errors: string[] = [];
  if (password.length < PASSWORD_POLICY.minLength) {
    errors.push(`Sifre en az ${PASSWORD_POLICY.minLength} karakter olmalidir.`);
  }
  if (PASSWORD_POLICY.requireUpper && !/[A-Z]/.test(password)) {
    errors.push("Sifre en az bir buyuk harf icermelidir.");
  }
  if (PASSWORD_POLICY.requireLower && !/[a-z]/.test(password)) {
    errors.push("Sifre en az bir kucuk harf icermelidir.");
  }
  if (PASSWORD_POLICY.requireDigit && !/[0-9]/.test(password)) {
    errors.push("Sifre en az bir rakam icermelidir.");
  }
  if (PASSWORD_POLICY.requireSpecial && !/[^A-Za-z0-9]/.test(password)) {
    errors.push("Sifre en az bir ozel karakter icermelidir.");
  }
  return errors;
}
