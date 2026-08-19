import { timingSafeEqual } from "node:crypto";

/** Iki string'i zamanlama saldirilarina karsi sabit-zamanli karsilastirir (token/secret kontrolu icin). */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
