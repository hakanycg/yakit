import { describe, expect, it } from "vitest";
import { maskContact } from "./maskPii.js";

describe("maskContact", () => {
  it("masks an email's local part while keeping the domain readable", () => {
    const masked = maskContact("ayse.yilmaz@example.com");
    expect(masked).toBe("ay*********@example.com");
    expect(masked).not.toContain("yilmaz");
  });

  it("keeps very short email local parts partially visible", () => {
    const masked = maskContact("a@example.com");
    expect(masked).toBe("a*@example.com");
  });

  it("masks a phone number, keeping only the last 4 digits", () => {
    const masked = maskContact("+90 532 111 22 33");
    expect(masked).toBe("********2233");
    expect(masked).not.toContain("532");
  });

  it("fully masks a very short phone-like string", () => {
    expect(maskContact("123")).toBe("***");
  });
});
