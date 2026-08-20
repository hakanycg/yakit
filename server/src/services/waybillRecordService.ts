import { db } from "../db/index.js";
import type { UserRow, WaybillRow } from "../db/types.js";

export function getWaybillForMovement(movementId: number): WaybillRow | undefined {
  return db.prepare<[number], WaybillRow>("SELECT * FROM waybills WHERE movement_id = ?").get(movementId);
}

export function recordWaybillSuccess(stationId: number, movementId: number, providerWaybillId: string, actor: UserRow): WaybillRow {
  db.prepare(
    `INSERT INTO waybills (station_id, movement_id, status, provider_waybill_id, created_by) VALUES (?, ?, 'sent', ?, ?)
     ON CONFLICT(movement_id) DO UPDATE SET status = 'sent', provider_waybill_id = excluded.provider_waybill_id, error_message = NULL, created_by = excluded.created_by, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(stationId, movementId, providerWaybillId, actor.id);
  return getWaybillForMovement(movementId)!;
}

export function recordWaybillFailure(stationId: number, movementId: number, errorMessage: string, actor: UserRow): WaybillRow {
  db.prepare(
    `INSERT INTO waybills (station_id, movement_id, status, error_message, created_by) VALUES (?, ?, 'failed', ?, ?)
     ON CONFLICT(movement_id) DO UPDATE SET status = 'failed', error_message = excluded.error_message, created_by = excluded.created_by, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(stationId, movementId, errorMessage, actor.id);
  return getWaybillForMovement(movementId)!;
}

export function serializeWaybill(w: WaybillRow) {
  return {
    status: w.status,
    providerWaybillId: w.provider_waybill_id,
    errorMessage: w.error_message,
    createdAt: w.created_at,
  };
}
