import { getSetting, setSetting } from "./settingsStore.js";
import type { UserRow } from "../db/types.js";

/**
 * Yanlis yakit onleme modu.
 *
 * Bugune kadar musteri yanlis yakit turu secince yalnizca bir onay ekrani gorurdu
 * (bkz. FuelStep.tsx) - "devam et" derse dolum yine baslardi. Bu, para iadesiyle
 * duzeltilemeyecek fiziksel bir hataya (motor hasari, depo temizligi) karsi tek
 * savunma satirinin musterinin kendi dikkatine birakilmasi demekti.
 *
 * "warn" (varsayilan): mevcut davranis, yalnizca uyarir.
 * "block": dolum hic baslamaz, musteri personelle gorusmeye yonlendirilir.
 *
 * Deger deliveryVarianceService.ts'teki desenle AYNI: settingsStore uzerinde
 * istasyon bazli, serbest metin (burada bir enum) olarak saklanir.
 */

export type WrongFuelMode = "warn" | "block";

const MODE_KEY = "wrong_fuel_mode";
const DEFAULT_MODE: WrongFuelMode = "warn";

export class WrongFuelSettingsError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export function getWrongFuelMode(stationId: number): WrongFuelMode {
  const raw = getSetting(stationId, MODE_KEY);
  return raw === "block" ? "block" : DEFAULT_MODE;
}

export function setWrongFuelMode(stationId: number, mode: WrongFuelMode, actor: UserRow): WrongFuelMode {
  if (mode !== "warn" && mode !== "block") {
    throw new WrongFuelSettingsError("Gecersiz mod - 'warn' veya 'block' olmalidir.", 400);
  }
  setSetting(stationId, MODE_KEY, mode, actor);
  return mode;
}
