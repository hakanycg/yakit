import { db } from "../db/index.js";
import type { PumpRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";
import { clearDispenserDriverFor, setDispenserDriverFor, simulatedDispenserDriver } from "./dispenserDriver.js";

export function listPumps(stationId: number): PumpRow[] {
  return db.prepare<[number], PumpRow>("SELECT * FROM pumps WHERE station_id = ? ORDER BY number").all(stationId);
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
    protocolType: p.protocol_type,
    // Istasyon haritasinda "3 numarali pompada kim var, ne kadar aldi" sorusunun cevabi.
    // Islem kimligi tek basina bunu soylemiyordu; operator her defasinda islem listesine
    // gidip aramak zorunda kaliyordu.
    activeSale: activeSaleFor(p.current_transaction_id),
    updatedAt: p.updated_at,
  };
}

interface ActiveSaleRow {
  plate: string;
  fuel_type: string;
  dispensed_liters: number;
  total_amount: number;
  discount_amount: number;
  status: string;
}

/** Pompada su an akan dolumun ozeti; pompa bostaysa (veya islem kapandiysa) null. */
function activeSaleFor(transactionId: number | null): {
  transactionId: number;
  plate: string;
  fuelType: string;
  liters: number;
  amount: number;
} | null {
  if (!transactionId) return null;
  const t = db
    .prepare<[number], ActiveSaleRow>(
      `SELECT plate, fuel_type, dispensed_liters, total_amount, discount_amount, status
         FROM transactions WHERE id = ?`
    )
    .get(transactionId);
  if (!t) return null;
  return {
    transactionId,
    plate: t.plate,
    fuelType: t.fuel_type,
    liters: t.dispensed_liters,
    // Musteriden tahsil edilen net tutar (indirim dusulmus) - haritada gorunen rakam,
    // musterinin odedigiyle ayni olmali.
    amount: Math.max(0, t.total_amount - t.discount_amount),
  };
}

export function broadcastPumps(stationId: number): void {
  broadcast(`pumps:${stationId}`, listPumps(stationId).map(serializePump));
}

/**
 * Coklu pompa cihazi mimarisi (bkz. dispenserDriver.ts kayit defteri): bu pompanin
 * iletisim protokolunu kaydeder ve VARSAYILAN yerine bu pompaya ozel bir surucuyu
 * hemen devreye alir - sunucu yeniden baslatilmadan da tutarli davransin diye
 * (bkz. loadConfiguredDispenserDrivers, sunucu acilisinda ayni islemi yapar).
 * Gercek bir protokol icin gercek surucu henuz yazilmadigindan (saha isi, donanim
 * gerektirir) simulasyon surucusune dusulur - protokol null'a cekilirse pompa
 * global VARSAYILANA doner.
 */
export function updatePumpProtocol(id: number, protocolType: string | null): PumpRow {
  db.prepare("UPDATE pumps SET protocol_type = ?, updated_at = ? WHERE id = ?").run(protocolType, new Date().toISOString(), id);
  if (protocolType) setDispenserDriverFor(id, simulatedDispenserDriver);
  else clearDispenserDriverFor(id);
  const pump = getPump(id)!;
  broadcastPumps(pump.station_id);
  return pump;
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

  const pump = getPump(id);
  if (pump) broadcastPumps(pump.station_id);
}
