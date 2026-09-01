import { describe, expect, it } from "vitest";
import { normalizePlate } from "./plate.js";

describe("normalizePlate", () => {
  it("strips all whitespace regardless of where it appears", () => {
    expect(normalizePlate("06VY894")).toBe("06VY894");
    expect(normalizePlate("06 VY 894")).toBe("06VY894");
    expect(normalizePlate("06  VY   894")).toBe("06VY894");
    expect(normalizePlate(" 06VY894 ")).toBe("06VY894");
  });

  it("uppercases", () => {
    expect(normalizePlate("06vy894")).toBe("06VY894");
  });

  it("makes differently-spaced inputs of the same plate compare equal", () => {
    expect(normalizePlate("34 ABC 123")).toBe(normalizePlate("34ABC123"));
    expect(normalizePlate("34 ABC123")).toBe(normalizePlate("34ABC 123"));
  });
});
