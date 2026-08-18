import { db } from "../db/index.js";
import type { PumpRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";

export function listPumps(): PumpRow[] {
  return db.prepare<[], PumpRow>("SELECT * FROM pumps ORDER BY number").all();
}

export function getPump(id: number): PumpRow | undefined {
  return db.prepare<[number], PumpRow>("SELECT * FROM pumps WHERE id = ?").get(id);
}

export function serializePump(p: PumpRow) {
  return {
    id: p.id,
    stationId: p.station_id,
    number: p.number,
    label: p.label,
    status: p.status,
    fuelTypes: JSON.parse(p.fuel_types) as string[],
    posX: p.pos_x,
    posY: p.pos_y,
    faultCode: p.fault_code,
    faultMessage: p.fault_message,
    currentTransactionId: p.current_transaction_id,
    updatedAt: p.updated_at,
  };
}

export function broadcastPumps(): void {
  broadcast("pumps", listPumps().map(serializePump));
}

export function setPumpStatus(
  id: number,
  status: PumpRow["status"],
  extra: { faultCode?: string | null; faultMessage?: string | null; currentTransactionId?: number | null } = {}
): void {
  const fields: string[] = ["status = ?", "updated_at = ?"];
  const values: unknown[] = [status, new Date().toISOString()];

  if ("faultCode" in extra) {
    fields.push("fault_code = ?");
    values.push(extra.faultCode ?? null);
  }
  if ("faultMessage" in extra) {
    fields.push("fault_message = ?");
    values.push(extra.faultMessage ?? null);
  }
  if ("currentTransactionId" in extra) {
    fields.push("current_transaction_id = ?");
    values.push(extra.currentTransactionId ?? null);
  }

  values.push(id);
  db.prepare(`UPDATE pumps SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  broadcastPumps();
}
