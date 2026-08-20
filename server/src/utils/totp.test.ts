import { describe, expect, it } from "vitest";
import { buildOtpauthUri, generateTotpCode, generateTotpSecret, verifyTotpCode } from "./totp.js";

describe("totp", () => {
  it("matches the RFC 6238 test vector (secret='12345678901234567890', t=59s -> 287082)", () => {
    const code = generateTotpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59 * 1000);
    expect(code).toBe("287082");
  });

  it("verifies a code generated for the current time", () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    expect(verifyTotpCode(secret, code)).toBe(true);
  });

  it("rejects an incorrect code", () => {
    const secret = generateTotpSecret();
    const correct = generateTotpCode(secret);
    const wrong = correct === "000000" ? "111111" : "000000";
    expect(verifyTotpCode(secret, wrong)).toBe(false);
  });

  it("rejects malformed input (non-6-digit)", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "12345")).toBe(false);
    expect(verifyTotpCode(secret, "abcdef")).toBe(false);
  });

  it("tolerates one time-step of clock drift", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const previousStepCode = generateTotpCode(secret, now - 30_000);
    expect(verifyTotpCode(secret, previousStepCode, now)).toBe(true);
  });

  it("rejects a code far outside the tolerance window", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const farPastCode = generateTotpCode(secret, now - 10 * 60_000);
    expect(verifyTotpCode(secret, farPastCode, now)).toBe(false);
  });

  it("generates distinct secrets each call", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
  });

  it("builds an otpauth:// URI containing the secret and issuer", () => {
    const uri = buildOtpauthUri("ABCDEFGHIJKLMNOP", "someuser");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("secret=ABCDEFGHIJKLMNOP");
    expect(uri).toContain("issuer=Yakit");
  });
});
