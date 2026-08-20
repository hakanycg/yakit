import { db } from "../db/index.js";
import type { LoyaltyAccountRow, LoyaltyMovementRow, UserRow } from "../db/types.js";
import { getSetting, setSetting } from "./fuelSyncService.js";

export class LoyaltyError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface LoyaltyConfig {
  enabled: boolean;
  pointsPerLiter: number;
  pointValueTry: number;
}

const DEFAULT_CONFIG: LoyaltyConfig = { enabled: false, pointsPerLiter: 1, pointValueTry: 0.1 };

export function getLoyaltyConfig(stationId: number): LoyaltyConfig {
  const enabled = getSetting(stationId, "loyalty_enabled");
  const pointsPerLiter = getSetting(stationId, "loyalty_points_per_liter");
  const pointValueTry = getSetting(stationId, "loyalty_point_value_try");
  return {
    enabled: enabled !== null ? enabled === "true" : DEFAULT_CONFIG.enabled,
    pointsPerLiter: pointsPerLiter !== null ? Number(pointsPerLiter) : DEFAULT_CONFIG.pointsPerLiter,
    pointValueTry: pointValueTry !== null ? Number(pointValueTry) : DEFAULT_CONFIG.pointValueTry,
  };
}

export function setLoyaltyConfig(stationId: number, config: Partial<LoyaltyConfig>, actor: UserRow): LoyaltyConfig {
  if (config.enabled !== undefined) setSetting(stationId, "loyalty_enabled", String(config.enabled), actor);
  if (config.pointsPerLiter !== undefined) setSetting(stationId, "loyalty_points_per_liter", String(config.pointsPerLiter), actor);
  if (config.pointValueTry !== undefined) setSetting(stationId, "loyalty_point_value_try", String(config.pointValueTry), actor);
  return getLoyaltyConfig(stationId);
}

function normalizePlate(plate: string): string {
  return plate.toUpperCase().replace(/\s+/g, " ").trim();
}

function getAccount(stationId: number, plate: string): LoyaltyAccountRow | undefined {
  return db
    .prepare<[number, string], LoyaltyAccountRow>("SELECT * FROM loyalty_accounts WHERE station_id = ? AND plate = ?")
    .get(stationId, normalizePlate(plate));
}

export function getBalance(stationId: number, plate: string): number {
  return getAccount(stationId, plate)?.points ?? 0;
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
  return { plate: normalizePlate(plate), points: getBalance(stationId, plate) };
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
