import { db } from "../db/index.js";
import { recordAudit } from "./auditService.js";
import type { FuelType, StationRow, UserRow } from "../db/types.js";
import { logger } from "../utils/logger.js";

// Kaynak: hasanadiguzel.com.tr'nin ucretsiz akaryakit API'si. Resmi (EPDK) bir
// veri kaynagi degildir; referans/yaklasik guncelleme amaclidir.
export const TURKEY_CITIES = [
  "ADANA", "ADIYAMAN", "AFYON", "AGRI", "AKSARAY", "AMASYA", "ANKARA", "ANTALYA",
  "AYDIN", "BALIKESIR", "BARTIN", "BATMAN", "BILECIK", "BOLU", "BURDUR", "BURSA",
  "CANAKKALE", "CANKIRI", "CORUM", "DENIZLI", "DIYARBAKIR", "DUZCE", "EDIRNE",
  "ELAZIĞ", "ERZINCAN", "ERZURUM", "ESKISEHIR", "GAZİANTEP", "GIRESUN", "HATAY",
  "ISPARTA", "ISTANBUL", "IZMIR", "İÇEL", "K.MARAS", "KARABUK", "KARAMAN",
  "KASTAMONU", "KAYSERI", "KIRIKKALE", "KIRKLARELI", "KIRSEHIR", "KOCAELI",
  "KONYA", "KUTAHYA", "MALATYA", "MANISA", "MARDİN", "MUGLA", "NEVSEHIR",
  "NİĞDE", "ORDU", "OSMANIYE", "RIZE", "SAKARYA", "SAMSUN", "SIVAS", "SİNOP",
  "ŞANLIURFA", "TEKIRDAG", "TOKAT", "TRABZON", "USAK", "VAN", "YALOVA",
  "YOZGAT", "ZONGULDAK",
] as const;

export type TurkeyCity = (typeof TURKEY_CITIES)[number];

const FETCH_TIMEOUT_MS = 8000;

interface ExternalFuelRecord {
  "Kursunsuz_95(Excellium95)_TL/lt"?: string;
  "Motorin(Eurodiesel)_TL/lt"?: string;
  "Otogaz_TL/lt"?: string;
  [key: string]: string | undefined;
}

interface ExternalApiResponse {
  qualifications?: { city: string; cityID: number };
  data?: Record<string, ExternalFuelRecord>;
  error?: { code: number; text: string };
}

function parseTurkishDecimal(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return null;
  const normalized = trimmed.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return null;
  return n;
}

export interface FetchedPrices {
  benzin: number | null;
  motorin: number | null;
  lpg: number | null;
  raw: ExternalFuelRecord;
}

export async function fetchExternalFuelPrices(city: TurkeyCity): Promise<FetchedPrices> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`https://www.hasanadiguzel.com.tr/api/akaryakit/sehir=${encodeURIComponent(city)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Kaynak API HTTP ${res.status} dondurdu.`);
    }
    const body = (await res.json()) as ExternalApiResponse;
    if (body.error) {
      throw new Error(`Kaynak API hatasi: ${body.error.text}`);
    }
    const records = body.data ? Object.values(body.data) : [];
    if (records.length === 0) {
      throw new Error("Kaynak API bu sehir icin veri dondurmedi.");
    }
    const record = records[0]!;

    return {
      benzin: parseTurkishDecimal(record["Kursunsuz_95(Excellium95)_TL/lt"]),
      motorin: parseTurkishDecimal(record["Motorin(Eurodiesel)_TL/lt"]),
      lpg: parseTurkishDecimal(record["Otogaz_TL/lt"]),
      raw: record,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface SyncResult {
  city: TurkeyCity;
  updated: Partial<Record<FuelType, number>>;
  skipped: FuelType[];
  timestamp: string;
}

/** Harici kaynaktan fiyatlari ceker ve gecerli olanlari bir istasyonun fuel_prices satirlarina yazar. */
export async function runFuelPriceSync(stationId: number, city: TurkeyCity, actor: UserRow | null): Promise<SyncResult> {
  const fetched = await fetchExternalFuelPrices(city);
  const now = new Date().toISOString();
  const mapping: Array<{ fuelType: FuelType; value: number | null }> = [
    { fuelType: "benzin", value: fetched.benzin },
    { fuelType: "motorin", value: fetched.motorin },
    { fuelType: "lpg", value: fetched.lpg },
  ];

  const updated: Partial<Record<FuelType, number>> = {};
  const skipped: FuelType[] = [];

  const update = db.prepare("UPDATE fuel_prices SET price_per_liter = ?, updated_at = ? WHERE station_id = ? AND fuel_type = ?");

  for (const { fuelType, value } of mapping) {
    if (value === null) {
      skipped.push(fuelType);
      continue;
    }
    update.run(value, now, stationId, fuelType);
    updated[fuelType] = value;
  }

  setSetting(stationId, "fuel_sync_last_run_at", now, actor);
  setSetting(stationId, "fuel_sync_last_status", "success", actor);
  setSetting(stationId, "fuel_sync_last_summary", JSON.stringify({ city, updated, skipped }), actor);

  recordAudit({
    user: actor,
    action: "fuel_price_auto_synced",
    entityType: "fuel_price",
    details: { city, updated, skipped, source: "hasanadiguzel.com.tr" },
    stationId,
  });

  return { city, updated, skipped, timestamp: now };
}

export function getSetting(stationId: number, key: string): string | null {
  const row = db
    .prepare<[number, string], { value: string }>("SELECT value FROM settings WHERE station_id = ? AND key = ?")
    .get(stationId, key);
  return row?.value ?? null;
}

export function setSetting(stationId: number, key: string, value: string, actor: UserRow | null): void {
  db.prepare(
    `INSERT INTO settings (station_id, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(station_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(stationId, key, value, new Date().toISOString(), actor?.id ?? null);
}

export interface FuelSyncConfig {
  enabled: boolean;
  city: TurkeyCity;
  intervalMinutes: number;
}

const DEFAULT_CONFIG: FuelSyncConfig = { enabled: false, city: "ISTANBUL", intervalMinutes: 360 };

export function getFuelSyncConfig(stationId: number): FuelSyncConfig {
  const enabled = getSetting(stationId, "fuel_sync_enabled") === "true";
  const cityRaw = getSetting(stationId, "fuel_sync_city");
  const city = (TURKEY_CITIES as readonly string[]).includes(cityRaw ?? "") ? (cityRaw as TurkeyCity) : DEFAULT_CONFIG.city;
  const intervalRaw = Number(getSetting(stationId, "fuel_sync_interval_minutes"));
  const intervalMinutes = Number.isFinite(intervalRaw) && intervalRaw >= 15 ? intervalRaw : DEFAULT_CONFIG.intervalMinutes;
  return { enabled, city, intervalMinutes };
}

export function setFuelSyncConfig(stationId: number, config: Partial<FuelSyncConfig>, actor: UserRow | null): void {
  if (config.enabled !== undefined) setSetting(stationId, "fuel_sync_enabled", String(config.enabled), actor);
  if (config.city !== undefined) setSetting(stationId, "fuel_sync_city", config.city, actor);
  if (config.intervalMinutes !== undefined) setSetting(stationId, "fuel_sync_interval_minutes", String(config.intervalMinutes), actor);
}

/** Sunucu basladiginda ve periyodik olarak cagrilir; senkronizasyonu acik olan tum istasyonlar icin zamani gelmisse tetikler. */
export async function maybeRunScheduledSync(): Promise<void> {
  const stations = db.prepare<[], StationRow>("SELECT * FROM stations WHERE active = 1").all();

  for (const station of stations) {
    const config = getFuelSyncConfig(station.id);
    if (!config.enabled) continue;

    const lastRunAt = getSetting(station.id, "fuel_sync_last_run_at");
    const dueAt = lastRunAt ? new Date(lastRunAt).getTime() + config.intervalMinutes * 60_000 : 0;
    if (Date.now() < dueAt) continue;

    try {
      const result = await runFuelPriceSync(station.id, config.city, null);
      logger.info({ station: station.slug, result }, "Otomatik yakit fiyati senkronizasyonu tamamlandi.");
    } catch (err) {
      setSetting(station.id, "fuel_sync_last_status", "error", null);
      setSetting(
        station.id,
        "fuel_sync_last_summary",
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        null
      );
      logger.error({ station: station.slug, err }, "Otomatik yakit fiyati senkronizasyonu basarisiz.");
    }
  }
}
