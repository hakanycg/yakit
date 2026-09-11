import { db } from "../db/index.js";
import type { LoyaltyAccountRow, LoyaltyMovementRow, UserRow } from "../db/types.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { normalizePlate } from "../utils/plate.js";
import { recordAudit } from "./auditService.js";
import { logger } from "../utils/logger.js";

export class LoyaltyError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export type LoyaltyTier = "bronze" | "silver" | "gold";

export interface LoyaltyConfig {
  enabled: boolean;
  pointsPerLiter: number;
  pointValueTry: number;
  /** Bu kademeye ulasmak icin gereken YASAM BOYU kazanilan puan (bkz. getTier). */
  tierSilverThreshold: number;
  tierGoldThreshold: number;
  /** Puan gecerlilik suresi (bkz. expireOldPoints) - varsayilan KAPALI. */
  pointExpiryEnabled: boolean;
  pointExpiryMonths: number;
}

const DEFAULT_CONFIG: LoyaltyConfig = {
  enabled: false,
  pointsPerLiter: 1,
  pointValueTry: 0.1,
  tierSilverThreshold: 500,
  tierGoldThreshold: 2000,
  pointExpiryEnabled: false,
  pointExpiryMonths: 12,
};

export function getLoyaltyConfig(stationId: number): LoyaltyConfig {
  const enabled = getSetting(stationId, "loyalty_enabled");
  const pointsPerLiter = getSetting(stationId, "loyalty_points_per_liter");
  const pointValueTry = getSetting(stationId, "loyalty_point_value_try");
  const tierSilverThreshold = getSetting(stationId, "loyalty_tier_silver_threshold");
  const tierGoldThreshold = getSetting(stationId, "loyalty_tier_gold_threshold");
  const pointExpiryEnabled = getSetting(stationId, "loyalty_point_expiry_enabled");
  const pointExpiryMonths = getSetting(stationId, "loyalty_point_expiry_months");
  return {
    enabled: enabled !== null ? enabled === "true" : DEFAULT_CONFIG.enabled,
    pointsPerLiter: pointsPerLiter !== null ? Number(pointsPerLiter) : DEFAULT_CONFIG.pointsPerLiter,
    pointValueTry: pointValueTry !== null ? Number(pointValueTry) : DEFAULT_CONFIG.pointValueTry,
    tierSilverThreshold: tierSilverThreshold !== null ? Number(tierSilverThreshold) : DEFAULT_CONFIG.tierSilverThreshold,
    tierGoldThreshold: tierGoldThreshold !== null ? Number(tierGoldThreshold) : DEFAULT_CONFIG.tierGoldThreshold,
    pointExpiryEnabled: pointExpiryEnabled !== null ? pointExpiryEnabled === "true" : DEFAULT_CONFIG.pointExpiryEnabled,
    pointExpiryMonths: pointExpiryMonths !== null ? Number(pointExpiryMonths) : DEFAULT_CONFIG.pointExpiryMonths,
  };
}

export function setLoyaltyConfig(stationId: number, config: Partial<LoyaltyConfig>, actor: UserRow): LoyaltyConfig {
  if (config.enabled !== undefined) setSetting(stationId, "loyalty_enabled", String(config.enabled), actor);
  if (config.pointsPerLiter !== undefined) setSetting(stationId, "loyalty_points_per_liter", String(config.pointsPerLiter), actor);
  if (config.pointValueTry !== undefined) setSetting(stationId, "loyalty_point_value_try", String(config.pointValueTry), actor);
  if (config.tierSilverThreshold !== undefined) setSetting(stationId, "loyalty_tier_silver_threshold", String(config.tierSilverThreshold), actor);
  if (config.tierGoldThreshold !== undefined) setSetting(stationId, "loyalty_tier_gold_threshold", String(config.tierGoldThreshold), actor);
  if (config.pointExpiryEnabled !== undefined) setSetting(stationId, "loyalty_point_expiry_enabled", String(config.pointExpiryEnabled), actor);
  if (config.pointExpiryMonths !== undefined) setSetting(stationId, "loyalty_point_expiry_months", String(config.pointExpiryMonths), actor);
  return getLoyaltyConfig(stationId);
}

/**
 * Kademe, MEVCUT bakiyeye degil YASAM BOYU KAZANILAN puana gore belirlenir (bkz.
 * loyalty_accounts.lifetime_points) - aksi halde puanini harcayan (ör. indirim icin
 * kullanan) sadik bir musteri kademe kaybederdi, ki bu tam tersi bir tesvik yaratirdi.
 */
export function getTier(lifetimePoints: number, config: Pick<LoyaltyConfig, "tierSilverThreshold" | "tierGoldThreshold">): LoyaltyTier {
  if (lifetimePoints >= config.tierGoldThreshold) return "gold";
  if (lifetimePoints >= config.tierSilverThreshold) return "silver";
  return "bronze";
}

function getAccount(stationId: number, plate: string): LoyaltyAccountRow | undefined {
  return db
    .prepare<[number, string], LoyaltyAccountRow>("SELECT * FROM loyalty_accounts WHERE station_id = ? AND plate = ?")
    .get(stationId, normalizePlate(plate));
}

export function getBalance(stationId: number, plate: string): number {
  return getAccount(stationId, plate)?.points ?? 0;
}

export function getLifetimePoints(stationId: number, plate: string): number {
  return getAccount(stationId, plate)?.lifetime_points ?? 0;
}

function insertMovement(params: {
  stationId: number;
  plate: string;
  type: LoyaltyMovementRow["type"];
  points: number;
  balanceAfter: number;
  transactionId?: number | null;
  note?: string | null;
  userId?: number | null;
}): void {
  db.prepare(
    `INSERT INTO loyalty_movements (station_id, plate, type, points, balance_after, transaction_id, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.stationId,
    params.plate,
    params.type,
    params.points,
    params.balanceAfter,
    params.transactionId ?? null,
    params.note ?? null,
    params.userId ?? null
  );
}

function upsertBalance(stationId: number, plate: string, newBalance: number): void {
  const rounded = Math.round(newBalance * 100) / 100;
  db.prepare(
    `INSERT INTO loyalty_accounts (station_id, plate, points, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(station_id, plate) DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at`
  ).run(stationId, plate, rounded, new Date().toISOString());
}

/** Yalnizca earnPoints tarafindan cagrilir - redeem/refund/adjustment kademeyi etkilemez. */
function incrementLifetimePoints(stationId: number, plate: string, delta: number): void {
  db.prepare("UPDATE loyalty_accounts SET lifetime_points = lifetime_points + ? WHERE station_id = ? AND plate = ?").run(
    delta,
    stationId,
    plate
  );
}

/**
 * Kampanya bildirimi rizasi (bkz. marketingCampaignService.ts) - musteri kiosk'ta
 * makbuz e-posta/telefonunu girerken ayri bir onay kutusuyla belirtir (bkz.
 * receiptService.ts sendReceipt). points'e DOKUNMAZ (ON CONFLICT DO UPDATE'te
 * listelenmedigi icin mevcut deger korunur) - hesap yoksa 0 puanla olusturulur.
 * Musteri rizayi geri cekerse (consent=false) de AYNI yoldan cagrilir - acik
 * secim her iki yonde de yazilmalidir.
 *
 * contactEmail/contactPhone icin COALESCE kullanilir: musteri bir sonraki ziyarette
 * yalnizca TEK kanali girerse (ör. sadece telefon, e-posta kutusunu bos birakirse),
 * diger kanal null gecilmis olur - bu, o kanaldan RIZANIN GERI CEKILDIGI anlamina
 * gelmez, sadece o ziyarette girilmedigi anlamina gelir. Onceden kaydedilmis kanal
 * bu yuzden SILINMEZ, yalnizca musteri YENI bir deger girdiginde guncellenir.
 */
export function setMarketingConsent(
  stationId: number,
  plate: string,
  consent: boolean,
  contactEmail: string | null,
  contactPhone: string | null
): void {
  const normalized = normalizePlate(plate);
  db.prepare(
    `INSERT INTO loyalty_accounts (station_id, plate, points, marketing_consent, contact_email, contact_phone, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT(station_id, plate) DO UPDATE SET
       marketing_consent = excluded.marketing_consent,
       contact_email = COALESCE(excluded.contact_email, loyalty_accounts.contact_email),
       contact_phone = COALESCE(excluded.contact_phone, loyalty_accounts.contact_phone),
       updated_at = excluded.updated_at`
  ).run(stationId, normalized, consent ? 1 : 0, contactEmail, contactPhone, new Date().toISOString());
}

/** Odeme oncesi, musterinin talep ettigi puani bakiyeden dusup karsiligi TL indirim tutarini dondurur. Yetersiz bakiyede hata firlatir. */
export function redeemPoints(stationId: number, plate: string, points: number, transactionId: number): number {
  if (points <= 0) throw new LoyaltyError("Gecersiz puan miktari.", 400);
  const normalized = normalizePlate(plate);
  const current = getBalance(stationId, normalized);
  if (points > current) throw new LoyaltyError("Yetersiz sadakat puani.", 409);

  const newBalance = current - points;
  upsertBalance(stationId, normalized, newBalance);
  insertMovement({ stationId, plate: normalized, type: "redeem", points: -points, balanceAfter: newBalance, transactionId });

  const { pointValueTry } = getLoyaltyConfig(stationId);
  return Math.round(points * pointValueTry * 100) / 100;
}

/** Puan kullanilan bir islem iptal/basarisiz olursa, dusulen puanlari musteriye iade eder. */
export function refundPoints(stationId: number, plate: string, points: number, transactionId: number): void {
  if (points <= 0) return;
  const normalized = normalizePlate(plate);
  const current = getBalance(stationId, normalized);
  const newBalance = current + points;
  upsertBalance(stationId, normalized, newBalance);
  insertMovement({
    stationId,
    plate: normalized,
    type: "refund",
    points,
    balanceAfter: newBalance,
    transactionId,
    note: "Islem iptal/basarisiz oldugu icin puan iadesi",
  });
}

/** Tamamlanan bir islemin dagitilan litresine gore puan kazandirir; kazanilan puan miktarini dondurur. */
export function earnPoints(stationId: number, plate: string, dispensedLiters: number, transactionId: number): number {
  const { enabled, pointsPerLiter } = getLoyaltyConfig(stationId);
  if (!enabled || dispensedLiters <= 0 || pointsPerLiter <= 0) return 0;

  const normalized = normalizePlate(plate);
  const earned = Math.round(dispensedLiters * pointsPerLiter * 100) / 100;
  if (earned <= 0) return 0;

  const current = getBalance(stationId, normalized);
  const newBalance = current + earned;
  upsertBalance(stationId, normalized, newBalance);
  incrementLifetimePoints(stationId, normalized, earned);
  insertMovement({ stationId, plate: normalized, type: "earn", points: earned, balanceAfter: newBalance, transactionId });
  return earned;
}

/** Yonetici, musteri talebi/hata duzeltmesi icin bakiyeyi dogrudan ayarlar. */
export function adjustPoints(stationId: number, plate: string, newPoints: number, note: string, actor: UserRow): LoyaltyAccountRow {
  if (newPoints < 0) throw new LoyaltyError("Puan bakiyesi negatif olamaz.", 400);
  const normalized = normalizePlate(plate);
  const current = getBalance(stationId, normalized);
  const delta = Math.round((newPoints - current) * 100) / 100;

  upsertBalance(stationId, normalized, newPoints);
  insertMovement({ stationId, plate: normalized, type: "adjustment", points: delta, balanceAfter: newPoints, note, userId: actor.id });

  return getAccount(stationId, normalized)!;
}

export function listMovements(stationId: number, filters: { plate?: string; limit?: number }): (LoyaltyMovementRow & { username: string | null })[] {
  const clauses = ["m.station_id = ?"];
  const params: unknown[] = [stationId];
  if (filters.plate) {
    clauses.push("m.plate = ?");
    params.push(normalizePlate(filters.plate));
  }
  const limit = Math.min(filters.limit ?? 200, 1000);
  return db
    .prepare<unknown[], LoyaltyMovementRow & { username: string | null }>(
      `SELECT m.*, u.username as username
       FROM loyalty_movements m LEFT JOIN users u ON u.id = m.user_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(...params, limit);
}

export function serializeAccount(stationId: number, plate: string) {
  const lifetimePoints = getLifetimePoints(stationId, plate);
  const tier = getTier(lifetimePoints, getLoyaltyConfig(stationId));
  return { plate: normalizePlate(plate), points: getBalance(stationId, plate), lifetimePoints, tier };
}

export interface PointExpiryResult {
  stationId: number;
  cutoff: string;
  accountsExpired: number;
  pointsExpired: number;
}

/**
 * Uzun sure hareketsiz kalan hesaplarin puan BAKIYESINI sifirlar - lifetime_points'e
 * (kademeye) DOKUNMAZ, cunku bu bir "cezalandirma" degil, kullanilmayan bir hakkin
 * suresinin dolmasidir; musteri gecmiste kazandigi kademeyi kaybetmemelidir.
 *
 * KRITIK: loyalty_accounts.updated_at KASITLI OLARAK guncellenmez. Bu alan ayrica
 * dataRetentionService.ts'teki KVKK atil-hesap silme suresinin de saatidir (bkz.
 * sweepStation). upsertBalance() kullanilsaydi, her puan gecerlilik suresi dolumu
 * o saati sifirlar ve KVKK silme suresini SONSUZA KADAR ERTELERDI - iki ayri
 * mevzuat/is kuralinin birbirine sizmasi olurdu. Bu yuzden dogrudan, dar kapsamli
 * bir UPDATE kullanilir.
 */
function expireStationPoints(stationId: number, cutoff: string): { accountsExpired: number; pointsExpired: number } {
  const stale = db
    .prepare<[number, string], LoyaltyAccountRow>(
      "SELECT * FROM loyalty_accounts WHERE station_id = ? AND points > 0 AND updated_at < ?"
    )
    .all(stationId, cutoff);

  let pointsExpired = 0;
  for (const account of stale) {
    db.prepare("UPDATE loyalty_accounts SET points = 0 WHERE station_id = ? AND plate = ?").run(stationId, account.plate);
    insertMovement({
      stationId,
      plate: account.plate,
      type: "expire",
      points: -account.points,
      balanceAfter: 0,
      note: `Puan gecerlilik suresi doldu (${cutoff.slice(0, 10)} oncesi hareketsiz).`,
    });
    pointsExpired += account.points;
  }

  return { accountsExpired: stale.length, pointsExpired: Math.round(pointsExpired * 100) / 100 };
}

/**
 * Tum aktif istasyonlar icin calisir (bkz. index.ts, sweepDataRetention ile ayni desen).
 * Yalnizca sadakat programi AKTIF ve puan gecerlilik suresi AYRICA acik olan istasyonlarda
 * calisir - varsayilan KAPALI, cunku mevcut musterilerin puanini sessizce sifirlayan bir
 * surecin, istasyon bilinçli olarak acmadan kendiliginden baslamasi dogru olmaz.
 */
export function expireOldPoints(now = new Date()): PointExpiryResult[] {
  const stations = db.prepare<[], { id: number }>("SELECT id FROM stations WHERE active = 1").all();
  const results: PointExpiryResult[] = [];

  for (const station of stations) {
    try {
      const config = getLoyaltyConfig(station.id);
      if (!config.enabled || !config.pointExpiryEnabled) continue;

      const cutoffDate = new Date(now);
      cutoffDate.setMonth(cutoffDate.getMonth() - config.pointExpiryMonths);
      const cutoff = cutoffDate.toISOString();

      const { accountsExpired, pointsExpired } = db.transaction(() => expireStationPoints(station.id, cutoff))();
      if (accountsExpired === 0) continue;

      results.push({ stationId: station.id, cutoff, accountsExpired, pointsExpired });
      logger.info({ stationId: station.id, cutoff, accountsExpired, pointsExpired }, "Sadakat puani gecerlilik suresi uygulandi.");
      recordAudit({
        user: null,
        actorType: "system",
        actorLabel: "Puan gecerlilik suresi isi",
        action: "loyalty_points_expired",
        details: { cutoff, accountsExpired, pointsExpired },
        stationId: station.id,
      });
    } catch (err) {
      logger.error({ err, stationId: station.id }, "Sadakat puani gecerlilik suresi uygulanamadi.");
    }
  }

  return results;
}

export function serializeMovement(m: LoyaltyMovementRow & { username?: string | null }) {
  return {
    id: m.id,
    plate: m.plate,
    type: m.type,
    points: m.points,
    balanceAfter: m.balance_after,
    transactionId: m.transaction_id,
    note: m.note,
    username: m.username ?? null,
    createdAt: m.created_at,
  };
}
