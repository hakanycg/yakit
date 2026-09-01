import { describe, expect, it } from "vitest";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { WrongFuelSettingsError, getWrongFuelMode, setWrongFuelMode } from "./wrongFuelSettingsService.js";

describe("wrongFuelSettingsService", () => {
  it("defaults to warn mode", () => {
    const station = createTestStation();
    expect(getWrongFuelMode(station.id)).toBe("warn");
  });

  it("persists a mode change, scoped to the station", () => {
    const station = createTestStation();
    const otherStation = createTestStation();
    const admin = createTestUser(station.id, "admin");

    setWrongFuelMode(station.id, "block", admin);

    expect(getWrongFuelMode(station.id)).toBe("block");
    expect(getWrongFuelMode(otherStation.id)).toBe("warn");
  });

  it("rejects an invalid mode", () => {
    const station = createTestStation();
    const admin = createTestUser(station.id, "admin");
    expect(() => setWrongFuelMode(station.id, "invalid" as never, admin)).toThrow(WrongFuelSettingsError);
  });
});
