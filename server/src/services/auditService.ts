import { db } from "../db/index.js";
import type { UserRow } from "../db/types.js";

export function recordAudit(params: {
  user: UserRow | null;
  action: string;
  entityType?: string;
  entityId?: string | number;
  details?: unknown;
  ip?: string;
  stationId?: number | null;
}): void {
  const stationId = params.stationId !== undefined ? params.stationId : (params.user?.station_id ?? null);
  db.prepare(
    `INSERT INTO audit_log (station_id, user_id, username, action, entity_type, entity_id, details, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    stationId,
    params.user?.id ?? null,
    params.user?.username ?? null,
    params.action,
    params.entityType ?? null,
    params.entityId !== undefined ? String(params.entityId) : null,
    params.details !== undefined ? JSON.stringify(params.details) : null,
    params.ip ?? null
  );
}
