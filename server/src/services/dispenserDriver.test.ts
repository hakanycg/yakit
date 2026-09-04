import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestPump, createTestStation } from "../test/dbFixture.js";
import {
  clearDispenserDriverFor,
  clearDispenserDriverRegistry,
  getDispenserDriver,
  getDispenserDriverFor,
  loadConfiguredDispenserDrivers,
  setDispenserDriver,
  setDispenserDriverFor,
  simulatedDispenserDriver,
  type DispenserDriver,
} from "./dispenserDriver.js";

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

describe("coklu pompa cihazi mimarisi (per-pump driver registry)", () => {
  afterEach(() => {
    setDispenserDriver(simulatedDispenserDriver);
    clearDispenserDriverRegistry();
  });

  it("ozel surucu tanimlanmamis bir pompa icin VARSAYILANI doner", () => {
    expect(getDispenserDriverFor(999)).toBe(simulatedDispenserDriver);
  });

  it("bir pompaya ozel surucu tanimlamak DIGER pompalari etkilemez", () => {
    const fakeA: DispenserDriver = { pickFullTankTargetLiters: () => 40, tick: () => ({ liters: 1, nozzleStopped: false }), estimateMaxFullTankLiters: () => 40 };

    setDispenserDriverFor(1, fakeA);

    expect(getDispenserDriverFor(1)).toBe(fakeA);
    expect(getDispenserDriverFor(2)).toBe(simulatedDispenserDriver);
  });

  it("clearDispenserDriverFor pompayi tekrar VARSAYILANA dondurur", () => {
    setDispenserDriverFor(1, { pickFullTankTargetLiters: () => null, tick: () => ({ liters: 0, nozzleStopped: true }), estimateMaxFullTankLiters: () => 0 });
    clearDispenserDriverFor(1);
    expect(getDispenserDriverFor(1)).toBe(simulatedDispenserDriver);
  });

  it("VARSAYILAN degistirilince ozel surucusu olmayan pompalar yeni varsayilani kullanir", () => {
    const fakeDefault: DispenserDriver = { pickFullTankTargetLiters: () => null, tick: () => ({ liters: 2, nozzleStopped: false }), estimateMaxFullTankLiters: () => 60 };
    setDispenserDriver(fakeDefault);
    expect(getDispenserDriverFor(42)).toBe(fakeDefault);
  });
});

describe("loadConfiguredDispenserDrivers", () => {
  afterEach(() => {
    setDispenserDriver(simulatedDispenserDriver);
    clearDispenserDriverRegistry();
  });

  it("protokolu yapilandirilmis pompalari kayit defterine ekler (henuz simulasyon olarak)", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);
    db.prepare("UPDATE pumps SET protocol_type = 'rs485_modbus' WHERE id = ?").run(pumpId);

    loadConfiguredDispenserDrivers();

    // Gercek RS485/Modbus surucusu henuz yok - kayitli surucu simulasyon olmali.
    expect(getDispenserDriverFor(pumpId)).toBe(simulatedDispenserDriver);
  });

  it("protokolu tanimsiz (null) pompalara dokunmaz", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id);

    loadConfiguredDispenserDrivers();

    expect(getDispenserDriverFor(pumpId)).toBe(simulatedDispenserDriver);
  });
});
