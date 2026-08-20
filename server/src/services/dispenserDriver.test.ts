import { afterEach, describe, expect, it } from "vitest";
import { getDispenserDriver, setDispenserDriver, simulatedDispenserDriver, type DispenserDriver } from "./dispenserDriver.js";

describe("simulatedDispenserDriver", () => {
  it("picks a full-tank target within the realistic 28-55L range", () => {
    for (let i = 0; i < 50; i++) {
      const target = simulatedDispenserDriver.pickFullTankTargetLiters();
      expect(target).not.toBeNull();
      expect(target!).toBeGreaterThanOrEqual(28);
      expect(target!).toBeLessThanOrEqual(55);
    }
  });

  it("never reports the nozzle as physically stopped (no real hardware)", () => {
    const result = simulatedDispenserDriver.tick(500);
    expect(result.nozzleStopped).toBe(false);
    expect(result.liters).toBeGreaterThan(0);
  });

  it("estimateMaxFullTankLiters matches the upper bound used for pre-authorization", () => {
    expect(simulatedDispenserDriver.estimateMaxFullTankLiters()).toBe(55);
  });
});

describe("dispenser driver registry", () => {
  afterEach(() => {
    // Diger testleri etkilememesi icin varsayilan (simulasyon) surucuye geri don.
    setDispenserDriver(simulatedDispenserDriver);
  });

  it("defaults to the simulated driver", () => {
    expect(getDispenserDriver()).toBe(simulatedDispenserDriver);
  });

  it("allows swapping in a different driver (ör. gercek donanim entegrasyonu icin)", () => {
    const fakeHardwareDriver: DispenserDriver = {
      pickFullTankTargetLiters: () => null,
      tick: () => ({ liters: 1.5, nozzleStopped: true }),
      estimateMaxFullTankLiters: () => 60,
    };

    setDispenserDriver(fakeHardwareDriver);
    expect(getDispenserDriver()).toBe(fakeHardwareDriver);
    expect(getDispenserDriver().pickFullTankTargetLiters()).toBeNull();
    expect(getDispenserDriver().tick(500).nozzleStopped).toBe(true);
  });
});
