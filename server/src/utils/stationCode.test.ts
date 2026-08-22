import { describe, expect, it } from "vitest";
import { generateStationCode, normalizeStationCode } from "./stationCode.js";

describe("stationCode", () => {
  it("STM + rakam bicimindeki bir kod uretir", () => {
    const code = generateStationCode(() => false);
    expect(code).toMatch(/^STM\d{4}$/);
  });

  it("kod kullanimdaysa baska bir kod dener", () => {
    const taken = new Set<string>();
    const first = generateStationCode(() => false);
    taken.add(first);
    const second = generateStationCode((c) => taken.has(c));
    expect(second).not.toBe(first);
  });

  it("4 haneli alan tukendiginde hane sayisini artirarak devam eder", () => {
    // 4 haneli TUM kodlar dolu kabul edilirse, uretici 5 haneye gecmelidir.
    const code = generateStationCode((c) => c.length === "STM1234".length);
    expect(code).toMatch(/^STM\d{5,6}$/);
  });

  it("URL'den gelen kodu normalize eder", () => {
    expect(normalizeStationCode(" stm 1234 ")).toBe("STM1234");
    expect(normalizeStationCode("STM1234")).toBe("STM1234");
  });
});
