import { db } from "../db/index.js";
import type { FuelType, UserRow } from "../db/types.js";
import { broadcastAlarms, createAlarm } from "./alarmService.js";
import { getSetting, setSetting } from "./settingsStore.js";

/**
 * Tank dibinde su birikmesi.
 *
 * Yakit tanklarinin dibinde zamanla su toplanir (yogusma, kotu conta, dolum sirasinda
 * yagmur). Az miktari olagandir; birikince IKI ayri zarar verir:
 *
 *  1. MUSTERININ ARACINA: depoya giden su motora zarar verir. Bu, isletme icin
 *     dogrudan bir sorumluluk meselesidir - bu yuzden alarm KRITIK.
 *  2. OLCUME: su, yakitin altinda hacim kaplar. Seviye probu toplam yuksekligi
 *     gorurse tankta olduğundan cok yakit varmis gibi hesaplanir ve sapma takibi
 *     (bkz. fuelVarianceService.ts) sessizce yaniltilir.
 *
 * ATG problari su seviyesini ayri bir samandirayla olcer; personel de su bulucu
 * macunla daldirma cubugunda olcebilir. Olcum birimi HACIM DEGIL YUKSEKLIKTIR (mm):
 * tank tabanindaki birkac milimetrelik bir katman, tank capina gore cok farkli
 * hacimlere karsilik gelir ve is icin anlamli olan yukseklik.
 */

/**
 * Varsayilan uyari esigi (mm).
 *
 * Birkac milimetre yogusma olagandir; bu esik "servis cagirilmali" noktasidir.
 * Kendi bakim pratiginizle teyit edin - degeri istasyon bazinda degistirebilirsiniz.
 */
const DEFAULT_WATER_THRESHOLD_MM = 25;

const WATER_THRESHOLD_KEY = "tank_water_threshold_mm";

export function getWaterThresholdMm(stationId: number): number {
  const raw = getSetting(stationId, WATER_THRESHOLD_KEY);
  if (raw === null) return DEFAULT_WATER_THRESHOLD_MM;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WATER_THRESHOLD_MM;
}

export function setWaterThresholdMm(stationId: number, mm: number, actor: UserRow): number {
  if (!Number.isFinite(mm) || mm < 0 || mm > 1000) {
    throw new Error("Su seviyesi esigi 0 ile 1000 mm arasinda olmalidir.");
  }
  setSetting(stationId, WATER_THRESHOLD_KEY, String(mm), actor);
  return getWaterThresholdMm(stationId);
}

function waterAlarmType(fuelType: FuelType): string {
  return `tank_water_${fuelType}`;
}

/**
 * Olcumdeki su seviyesini degerlendirir; esik asilirsa bir kez kritik alarm acar,
 * seviye esigin altina dustugunde alarmi cozer.
 *
 * Tekrar bildirim gondermemenin yolu ayri bir "gonderildi mi" kolonu degil alarmin
 * kendisidir - dusuk bakiye ve vadesi gecen alacak uyarilariyla ayni desen.
 *
 * OLCULMEDI ile SIFIR ayri: su olculmemisse (null) hicbir sey yapilmaz. Olculmeyen
 * bir tanki "suyu yok" saymak, gercek bir birikmeyi sessizce gecistirmek olurdu.
 */
export function evaluateWaterLevel(
  stationId: number,
  fuelType: FuelType,
  waterLevelMm: number | null | undefined
): boolean {
  if (waterLevelMm === null || waterLevelMm === undefined || !Number.isFinite(waterLevelMm)) return false;

  const threshold = getWaterThresholdMm(stationId);
  const alarmType = waterAlarmType(fuelType);

  if (waterLevelMm < threshold) {
    const result = db
      .prepare("UPDATE alarms SET status = 'resolved', resolved_at = ? WHERE station_id = ? AND type = ? AND status != 'resolved'")
      .run(new Date().toISOString(), stationId, alarmType);
    if (result.changes > 0) broadcastAlarms(stationId);
    return false;
  }

  const existing = db
    .prepare<[number, string], { id: number }>("SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved' LIMIT 1")
    .get(stationId, alarmType);
  if (existing) return false;

  createAlarm({
    stationId,
    type: alarmType,
    severity: "critical",
    message:
      `${fuelType.toUpperCase()} tankinin dibinde ${waterLevelMm} mm su olculdu (esik ${threshold} mm). ` +
      `Su, musterinin aracina zarar verir ve seviye olcumunu yaniltir. Tankin bosaltilmasi/kurutulmasi icin ` +
      `servis cagirin.`,
  });
  return true;
}
