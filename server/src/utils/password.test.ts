import { describe, expect, it } from "vitest";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("verifies the correct password", () => {
    const hashed = hashPassword("Gecerli#Sifre123");
    expect(verifyPassword("Gecerli#Sifre123", hashed)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const hashed = hashPassword("Gecerli#Sifre123");
    expect(verifyPassword("YanlisSifre#456", hashed)).toBe(false);
  });

  it("uses a random salt per call (identical passwords hash differently)", () => {
    const a = hashPassword("AyniSifre#123456");
    const b = hashPassword("AyniSifre#123456");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("password policy", () => {
  it("rejects passwords shorter than 10 characters", () => {
    expect(validatePasswordPolicy("Ab1#567")).not.toHaveLength(0);
  });

  it("rejects passwords missing an uppercase letter", () => {
    expect(validatePasswordPolicy("gecerli#sifre123")).not.toHaveLength(0);
  });

  it("rejects passwords missing a digit", () => {
    expect(validatePasswordPolicy("Gecerli#Sifreee")).not.toHaveLength(0);
  });

  it("rejects passwords missing a special character", () => {
    expect(validatePasswordPolicy("GecerliSifre123")).not.toHaveLength(0);
  });

  it("accepts a password satisfying all rules", () => {
    expect(validatePasswordPolicy("Gecerli#Sifre123")).toHaveLength(0);
  });
});
