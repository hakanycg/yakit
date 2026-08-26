import { db } from "../db/index.js";
import type { FuelPriceRow, FuelType, ScheduledPriceChangeRow, UserRow } from "../db/types.js";
import { recordAudit } from "./auditService.js";
import { logger } from "../utils/logger.js";
import { broadcastFuelPrices } from "./fuelPriceService.js";

export class ScheduledPriceError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export function listSchedules(stationId: number): ScheduledPriceChangeRow[] {
  return db
    .prepare<[number], ScheduledPriceChangeRow>(
      "SELECT * FROM scheduled_price_changes WHERE station_id = ? ORDER BY scheduled_for DESC LIMIT 200"
    )
    .all(stationId);
}

export function createSchedule(
  stationId: number,
  fuelType: FuelType,
  pricePerLiter: number,
  scheduledFor: string,
  actor: UserRow
): ScheduledPriceChangeRow {
  const existing = db
    .prepare<[number, string], FuelPriceRow>("SELECT * FROM fuel_prices WHERE station_id = ? AND fuel_type = ?")
    .get(stationId, fuelType);
  if (!existing) throw new ScheduledPriceError("Gecersiz yakit tipi.", 404);

  const scheduledDate = new Date(scheduledFor);
  if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
    throw new ScheduledPriceError("Planlanan tarih gelecekte bir an olmalidir.", 400);
  }

  const result = db
    .prepare(
      "INSERT INTO scheduled_price_changes (station_id, fuel_type, price_per_liter, scheduled_for, created_by) VALUES (?, ?, ?, ?, ?)"
    )
    .run(stationId, fuelType, pricePerLiter, scheduledDate.toISOString(), actor.id);
  return db.prepare<[number], ScheduledPriceChangeRow>("SELECT * FROM scheduled_price_changes WHERE id = ?").get(result.lastInsertRowid as number)!;
}

export function cancelSchedule(stationId: number, id: number): void {
  const result = db
    .prepare("UPDATE scheduled_price_changes SET status = 'cancelled' WHERE id = ? AND station_id = ? AND status = 'pending'")
    .run(id, stationId);
  if (result.changes === 0) throw new ScheduledPriceError("Bekleyen bir planlanmis fiyat degisikligi bulunamadi.", 404);
}

/**
 * Periyodik olarak (bkz. index.ts) zamani gelmis (scheduled_for <= simdi) bekleyen
 * fiyat planlarini uygular - PATCH /api/settings/fuel-prices/:fuelType route'uyla
 * BIREBIR ayni islemi (fuel_prices guncelle + fuel_price_history kaydi + denetim
 * kaydi) yapar, sadece tetikleyici bir admin tiklamasi degil zamanlayicidir.
 */
export function applyDuePriceChanges(): void {
  const due = db
    .prepare<[string], ScheduledPriceChangeRow>("SELECT * FROM scheduled_price_changes WHERE status = 'pending' AND scheduled_for <= ?")
    .all(new Date().toISOString());

  for (const schedule of due) {
    try {
      const now = new Date().toISOString();
      const result = db
        .prepare("UPDATE fuel_prices SET price_per_liter = ?, updated_at = ? WHERE station_id = ? AND fuel_type = ?")
        .run(schedule.price_per_liter, now, schedule.station_id, schedule.fuel_type);
      if (result.changes === 0) {
        // Yakit tipi bu arada silinmis/degismis olabilir - uygulanamadi, iptal olarak isaretle.
        db.prepare("UPDATE scheduled_price_changes SET status = 'cancelled' WHERE id = ?").run(schedule.id);
        continue;
      }
      db.prepare("INSERT INTO fuel_price_history (station_id, fuel_type, price_per_liter, changed_by) VALUES (?, ?, ?, ?)").run(
        schedule.station_id,
        schedule.fuel_type,
        schedule.price_per_liter,
        schedule.created_by
      );
      db.prepare("UPDATE scheduled_price_changes SET status = 'applied', applied_at = ? WHERE id = ?").run(now, schedule.id);
      recordAudit({
        user: null,
        actorType: "system",
        actorLabel: "zamanlanmış fiyat işi",
        action: "fuel_price_scheduled_change_applied",
        entityType: "fuel_price",
        entityId: schedule.fuel_type,
        details: { pricePerLiter: schedule.price_per_liter, scheduleId: schedule.id },
        stationId: schedule.station_id,
      });
      broadcastFuelPrices(schedule.station_id);
    } catch (err) {
      logger.error({ err, scheduleId: schedule.id }, "Planlanmis fiyat degisikligi uygulanamadi.");
    }
  }
}

export function serializeSchedule(s: ScheduledPriceChangeRow) {
  return {
    id: s.id,
    fuelType: s.fuel_type,
    pricePerLiter: s.price_per_liter,
    scheduledFor: s.scheduled_for,
    status: s.status,
    createdAt: s.created_at,
    appliedAt: s.applied_at,
  };
}
