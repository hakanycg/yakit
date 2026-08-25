import { db } from "../db/index.js";
import type { FuelPriceRow, FuelTankRow, FuelType, UserRow } from "../db/types.js";
import { getSetting, setSetting } from "./settingsStore.js";

/**
 * Fiyat degisikligi guvenlik kontrolu - "fat-finger" korumasi.
 *
 * Fiyat guncellemesinin tek kontrolu "pozitif ve 1000'den kucuk" idi. 54,20 yerine 5,42
 * yazmak (ondalik kaymasi) bu kontrolden gecer ve PERSONELSIZ istasyonda bunu fark edecek
 * kimse yoktur: gece boyunca yakit maliyetin onda birine satilir. Ters yonde de ayni
 * derecede kotudur - 542,00 yazilirsa musteriler on kat fazla oder.
 *
 * Bu bir YASAK degil, bir HIZ KESICIDIR. Gercek fiyat siciramalari olur (ÖTV degisikligi,
 * kur soku); sistemin "olamaz" demeye hakki yok. Yapabilecegi sey, olagandisi bir degisikligi
 * kullaniciya SAYIYLA gosterip acik onay istemektir - yanlislikla yazilan bir rakam ile
 * bilerek girilen bir rakam arasindaki fark, ancak insanin kendisi tarafindan bilinebilir.
 */

/** Mevcut fiyata gore yuzde sapma esigi. %20: gercek bir gunluk zam bunun cok altindadir. */
const DEFAULT_MAX_CHANGE_PCT = 20;

const MAX_CHANGE_PCT_KEY = "price_guard_max_change_pct";

export interface PriceGuardSettings {
  maxChangePct: number;
}

export function getPriceGuardSettings(stationId: number): PriceGuardSettings {
  const raw = getSetting(stationId, MAX_CHANGE_PCT_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return { maxChangePct: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CHANGE_PCT };
}

export class PriceGuardError extends Error {
  constructor(
    message: string,
    public status = 409,
    public details?: unknown
  ) {
    super(message);
  }
}

export function updatePriceGuardSettings(stationId: number, maxChangePct: number, actor: UserRow): PriceGuardSettings {
  if (!Number.isFinite(maxChangePct) || maxChangePct < 0 || maxChangePct > 100) {
    throw new PriceGuardError("Fiyat sapma esigi 0 ile 100 arasinda bir yuzde olmalidir.", 400);
  }
  setSetting(stationId, MAX_CHANGE_PCT_KEY, String(maxChangePct), actor);
  return getPriceGuardSettings(stationId);
}

export interface PriceGuardWarning {
  currentPrice: number;
  newPrice: number;
  changePct: number;
  /** Sapma esigi asildi mi? */
  exceedsThreshold: boolean;
  /** Yeni fiyat, tankin agirlikli ortalama alis maliyetinin altinda mi? */
  belowCost: boolean;
  averageCostPerLiter: number | null;
  /** Onay gerekiyor mu? Iki uyaridan biri bile yeterlidir. */
  requiresConfirmation: boolean;
  /** Kullaniciya gosterilecek, sayilari iceren aciklama. */
  message: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Degisikligi degerlendirir. Onay gerekmiyorsa null doner.
 *
 * Iki ayri kontrol vardir ve BIRBIRININ YERINE GECMEZ:
 *
 *  - Sapma: mevcut fiyattan cok uzaklasmak. Ondalik kaymasini yakalayan kontrol budur.
 *  - Maliyet alti: yeni fiyat, o tanktaki yakitin agirlikli ortalama alis maliyetinin
 *    altinda. Sapma kucuk olsa bile zararina satis olabilir (maliyet yukselmisken fiyat
 *    sabit birakilmissa) ve bunu yalnizca maliyetle karsilastirmak gosterir.
 */
export function evaluatePriceChange(stationId: number, fuelType: FuelType, newPrice: number): PriceGuardWarning | null {
  const existing = db
    .prepare<[number, string], FuelPriceRow>("SELECT * FROM fuel_prices WHERE station_id = ? AND fuel_type = ?")
    .get(stationId, fuelType);
  if (!existing) return null;

  const currentPrice = existing.price_per_liter;
  const settings = getPriceGuardSettings(stationId);

  // Mevcut fiyat 0 ise (henuz hic fiyat girilmemis) kiyaslanacak bir taban yoktur;
  // ilk fiyat girisini onaya takmak gereksiz bir surtunme olurdu.
  const changePct = currentPrice > 0 ? round2(((newPrice - currentPrice) / currentPrice) * 100) : 0;
  const exceedsThreshold = currentPrice > 0 && Math.abs(changePct) > settings.maxChangePct;

  const tank = db
    .prepare<[number, string], FuelTankRow>("SELECT * FROM fuel_tanks WHERE station_id = ? AND fuel_type = ?")
    .get(stationId, fuelType);
  // Maliyeti girilmemis teslimatlar ortalamayi etkilemez, yani 0 "bedava aldik" degil
  // "bilmiyoruz" demektir (bkz. fuelStockService.addStock) - bilinmeyen maliyetle
  // karsilastirma yapilmaz.
  const averageCostPerLiter = tank && tank.average_cost_per_liter > 0 ? tank.average_cost_per_liter : null;
  const belowCost = averageCostPerLiter !== null && newPrice < averageCostPerLiter;

  if (!exceedsThreshold && !belowCost) return null;

  const parts: string[] = [];
  if (exceedsThreshold) {
    parts.push(
      `Fiyat ${currentPrice.toFixed(2)} TL/L'den ${newPrice.toFixed(2)} TL/L'ye degisiyor: ` +
        `%${Math.abs(changePct).toFixed(2)} ${changePct > 0 ? "artis" : "azalis"} (esik %${settings.maxChangePct}).`
    );
  }
  if (belowCost && averageCostPerLiter !== null) {
    parts.push(`Yeni fiyat, ortalama alis maliyetinin (${averageCostPerLiter.toFixed(2)} TL/L) ALTINDA - zararina satis.`);
  }
  parts.push("Rakami dogruladiysaniz onaylayin.");

  return {
    currentPrice,
    newPrice,
    changePct,
    exceedsThreshold,
    belowCost,
    averageCostPerLiter,
    requiresConfirmation: true,
    message: parts.join(" "),
  };
}

/**
 * Onay verilmediyse hata firlatir. Route'lar bunu cagirir; `force` kullanicinin ekranda
 * uyariyi gorup onayladigi anlamina gelir.
 */
export function assertPriceChangeAllowed(stationId: number, fuelType: FuelType, newPrice: number, force: boolean): void {
  if (force) return;
  const warning = evaluatePriceChange(stationId, fuelType, newPrice);
  if (warning) throw new PriceGuardError(warning.message, 409, { priceGuard: warning });
}
