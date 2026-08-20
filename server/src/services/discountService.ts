import { db } from "../db/index.js";
import type { DiscountCodeRow, FuelType, UserRow } from "../db/types.js";

export class DiscountError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function getActiveCode(stationId: number, code: string): DiscountCodeRow | undefined {
  return db
    .prepare<[number, string], DiscountCodeRow>("SELECT * FROM discount_codes WHERE station_id = ? AND code = ?")
    .get(stationId, normalizeCode(code));
}

/** Kod gecerliyse hesaplanan indirim tutarini dondurur; gecersizse aciklayici hata firlatir. Kullanim sayacini ARTIRMAZ (bkz. redeemCode). */
export function validateCode(stationId: number, code: string, fuelType: FuelType, totalAmount: number): { row: DiscountCodeRow; discountAmount: number } {
  const row = getActiveCode(stationId, code);
  if (!row || !row.active) throw new DiscountError("Gecersiz indirim kodu.", 404);

  const now = new Date().toISOString();
  if (row.starts_at && row.starts_at > now) throw new DiscountError("Bu kod henuz gecerli degil.", 409);
  if (row.expires_at && row.expires_at < now) throw new DiscountError("Bu kodun suresi dolmus.", 409);
  if (row.max_uses !== null && row.used_count >= row.max_uses) throw new DiscountError("Bu kodun kullanim limiti dolmus.", 409);
  if (row.fuel_type && row.fuel_type !== fuelType) throw new DiscountError("Bu kod secilen yakit tipi icin gecerli degil.", 409);

  const discountAmount = row.type === "percent" ? (totalAmount * row.value) / 100 : row.value;
  return { row, discountAmount: Math.round(Math.min(discountAmount, totalAmount) * 100) / 100 };
}

/** Bir islemde kod kullanildiginda kullanim sayacini artirir. validateCode ile aynı anda cagrilmali (odeme onayindan once). */
export function redeemCode(stationId: number, code: string): void {
  const result = db
    .prepare("UPDATE discount_codes SET used_count = used_count + 1 WHERE station_id = ? AND code = ?")
    .run(stationId, normalizeCode(code));
  if (result.changes === 0) throw new DiscountError("Gecersiz indirim kodu.", 404);
}

/** Kod kullanilan bir islem iptal/basarisiz olursa kullanim sayacini geri alir. */
export function releaseCode(stationId: number, code: string): void {
  db.prepare("UPDATE discount_codes SET used_count = MAX(0, used_count - 1) WHERE station_id = ? AND code = ?").run(stationId, normalizeCode(code));
}

export interface CreateCodeInput {
  code: string;
  type: "percent" | "fixed";
  value: number;
  fuelType?: FuelType;
  maxUses?: number;
  startsAt?: string;
  expiresAt?: string;
}

export function createCode(stationId: number, input: CreateCodeInput, actor: UserRow): DiscountCodeRow {
  const code = normalizeCode(input.code);
  const existing = getActiveCode(stationId, code);
  if (existing) throw new DiscountError("Bu kod zaten kullanimda.", 409);

  const result = db
    .prepare(
      `INSERT INTO discount_codes (station_id, code, type, value, fuel_type, max_uses, starts_at, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      stationId,
      code,
      input.type,
      input.value,
      input.fuelType ?? null,
      input.maxUses ?? null,
      input.startsAt ?? null,
      input.expiresAt ?? null,
      actor.id
    );
  return db.prepare<[number], DiscountCodeRow>("SELECT * FROM discount_codes WHERE id = ?").get(result.lastInsertRowid as number)!;
}

export function listCodes(stationId: number): DiscountCodeRow[] {
  return db.prepare<[number], DiscountCodeRow>("SELECT * FROM discount_codes WHERE station_id = ? ORDER BY created_at DESC").all(stationId);
}

export interface DiscountCodeStats {
  completedUses: number;
  totalDiscountGiven: number;
  revenueGenerated: number;
}

/**
 * Kod bazinda kullanim analitigi: yalnizca TAMAMLANMIS islemler uzerinden hesaplanir
 * (discount_codes.used_count ise iptal edilse bile o ana kadarki tum redeemCode
 * cagrilarini - kismen releaseCode ile geri alinanlari haric - sayar, yani "canli"
 * bir sayactir; bu fonksiyon ise gercek/kesin ciro etkisini gosterir).
 */
export function getUsageStats(stationId: number): Map<number, DiscountCodeStats> {
  const rows = db
    .prepare<[number], { id: number; completedUses: number; totalDiscountGiven: number; revenueGenerated: number }>(
      `SELECT dc.id as id,
              COALESCE(SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END), 0) as completedUses,
              COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.discount_amount ELSE 0 END), 0) as totalDiscountGiven,
              COALESCE(SUM(CASE WHEN t.status = 'completed' THEN MAX(0, t.total_amount - t.discount_amount) ELSE 0 END), 0) as revenueGenerated
       FROM discount_codes dc
       LEFT JOIN transactions t ON t.station_id = dc.station_id AND t.discount_code = dc.code
       WHERE dc.station_id = ?
       GROUP BY dc.id`
    )
    .all(stationId);
  return new Map(rows.map((r) => [r.id, { completedUses: r.completedUses, totalDiscountGiven: r.totalDiscountGiven, revenueGenerated: r.revenueGenerated }]));
}

export function setCodeActive(stationId: number, id: number, active: boolean): DiscountCodeRow {
  const result = db.prepare("UPDATE discount_codes SET active = ? WHERE station_id = ? AND id = ?").run(active ? 1 : 0, stationId, id);
  if (result.changes === 0) throw new DiscountError("Kod bulunamadi.", 404);
  return db.prepare<[number], DiscountCodeRow>("SELECT * FROM discount_codes WHERE id = ?").get(id)!;
}

export function serializeCode(c: DiscountCodeRow) {
  return {
    id: c.id,
    code: c.code,
    type: c.type,
    value: c.value,
    fuelType: c.fuel_type,
    maxUses: c.max_uses,
    usedCount: c.used_count,
    startsAt: c.starts_at,
    expiresAt: c.expires_at,
    active: !!c.active,
    createdAt: c.created_at,
  };
}
