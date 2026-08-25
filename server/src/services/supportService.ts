import { db } from "../db/index.js";
import type { UserRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";
import { broadcastAlarms, createAlarm } from "./alarmService.js";

/**
 * Kiosk'tan gelen musteri destek talepleri.
 *
 * Personelsiz istasyonda karti cekilip yakit akmayan bir musterinin baska hicbir yolu
 * yoktu; ekranin ona soyledigi tek sey "istasyon yoneticinizle iletisime gecin" idi -
 * personeli olmayan bir istasyonda. Talep, kritik alarma cevrilir; boylece mevcut
 * kritik alarm bildirim zinciri (e-posta/SMS, dayanikli yazma kuyrugu uzerinden)
 * hicbir ek is yapilmadan devreye girer.
 */

export class SupportError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export const SUPPORT_CATEGORIES = ["payment", "dispenser", "receipt", "other"] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

/**
 * Ayni kiosk'tan kisa surede gelen tekrarli talepler tek kayda toplanmaz ama alarm
 * uretmez: panige kapilan bir musteri butona ust uste basabilir ve her basis nobetci
 * personele ayri bir SMS gonderirse bildirim zinciri ise yaramaz hale gelir.
 */
const ALARM_DEDUP_WINDOW_MS = 10 * 60 * 1000;

const CATEGORY_LABEL: Record<SupportCategory, string> = {
  payment: "Odeme sorunu",
  dispenser: "Yakit akmiyor / pompa sorunu",
  receipt: "Fis/makbuz sorunu",
  other: "Diger",
};

export interface SupportRequestRow {
  id: number;
  station_id: number;
  kiosk_id: number | null;
  pump_id: number | null;
  transaction_id: number | null;
  category: SupportCategory;
  message: string | null;
  contact_phone: string | null;
  status: "open" | "resolved";
  alarm_id: number | null;
  resolved_by: number | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

export function serializeSupportRequest(r: SupportRequestRow & { pumpNumber?: number | null; resolvedByName?: string | null }) {
  return {
    id: r.id,
    stationId: r.station_id,
    kioskId: r.kiosk_id,
    pumpId: r.pump_id,
    pumpNumber: r.pumpNumber ?? null,
    transactionId: r.transaction_id,
    category: r.category,
    categoryLabel: CATEGORY_LABEL[r.category] ?? r.category,
    message: r.message,
    contactPhone: r.contact_phone,
    status: r.status,
    alarmId: r.alarm_id,
    resolvedBy: r.resolvedByName ?? null,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
  };
}

function broadcastSupport(stationId: number): void {
  broadcast(`support:${stationId}`, listSupportRequests(stationId, "open").map((r) => serializeSupportRequest(r)));
}

/**
 * Son ALARM_DEDUP_WINDOW_MS icinde ayni kiosk'tan alarm uretilmis bir talep var mi?
 * Kiosk kimligi bilinmiyorsa istasyon geneline bakilir.
 */
function recentAlarmedRequest(stationId: number, kioskId: number | null, now: number): boolean {
  const since = new Date(now - ALARM_DEDUP_WINDOW_MS).toISOString();
  const row = kioskId
    ? db
        .prepare<[number, number, string], { id: number }>(
          "SELECT id FROM support_requests WHERE station_id = ? AND kiosk_id = ? AND alarm_id IS NOT NULL AND created_at > ? LIMIT 1"
        )
        .get(stationId, kioskId, since)
    : db
        .prepare<[number, string], { id: number }>(
          "SELECT id FROM support_requests WHERE station_id = ? AND kiosk_id IS NULL AND alarm_id IS NOT NULL AND created_at > ? LIMIT 1"
        )
        .get(stationId, since);
  return row !== undefined;
}

export interface CreateSupportInput {
  stationId: number;
  kioskId?: number | null;
  pumpId?: number | null;
  transactionId?: number | null;
  category: SupportCategory;
  message?: string | null;
  contactPhone?: string | null;
}

export interface CreateSupportResult {
  request: SupportRequestRow;
  alarmRaised: boolean;
}

export function createSupportRequest(input: CreateSupportInput, now = Date.now()): CreateSupportResult {
  if (!SUPPORT_CATEGORIES.includes(input.category)) {
    throw new SupportError("Gecersiz destek talebi kategorisi.", 400);
  }

  // Pompa ve islem, gonderen kiosk'un istasyonuna ait olmali: kiosk ucu musteri
  // tarafindan cagrildigindan, baska bir istasyonun islemine talep iliskilendirilmesi
  // engellenir.
  const pumpId = input.pumpId ?? null;
  if (pumpId !== null) {
    const pump = db
      .prepare<[number, number], { id: number }>("SELECT id FROM pumps WHERE id = ? AND station_id = ?")
      .get(pumpId, input.stationId);
    if (!pump) throw new SupportError("Pompa bu istasyona ait degil.", 400);
  }
  const transactionId = input.transactionId ?? null;
  if (transactionId !== null) {
    const t = db
      .prepare<[number, number], { id: number }>("SELECT id FROM transactions WHERE id = ? AND station_id = ?")
      .get(transactionId, input.stationId);
    if (!t) throw new SupportError("Islem bu istasyona ait degil.", 400);
  }

  const kioskId = input.kioskId ?? null;
  const shouldAlarm = !recentAlarmedRequest(input.stationId, kioskId, now);

  const result = db
    .prepare(
      `INSERT INTO support_requests
         (station_id, kiosk_id, pump_id, transaction_id, category, message, contact_phone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.stationId,
      kioskId,
      pumpId,
      transactionId,
      input.category,
      input.message?.trim() || null,
      input.contactPhone?.trim() || null,
      new Date(now).toISOString()
    );
  const id = result.lastInsertRowid as number;

  let alarmId: number | null = null;
  if (shouldAlarm) {
    const parts = [`Kiosk'tan musteri destek talebi #${id}: ${CATEGORY_LABEL[input.category]}`];
    if (pumpId !== null) {
      const pump = db.prepare<[number], { number: number }>("SELECT number FROM pumps WHERE id = ?").get(pumpId);
      if (pump) parts.push(`Pompa ${pump.number}`);
    }
    if (transactionId !== null) parts.push(`islem #${transactionId}`);
    if (input.message?.trim()) parts.push(`Musteri notu: ${input.message.trim()}`);
    if (input.contactPhone?.trim()) parts.push(`Geri arama: ${input.contactPhone.trim()}`);
    parts.push("Musteri su an istasyonda bekliyor olabilir.");

    const alarm = createAlarm({
      stationId: input.stationId,
      pumpId,
      type: "customer_support_request",
      severity: "critical",
      message: parts.join(" | "),
    });
    alarmId = alarm.id;
    db.prepare("UPDATE support_requests SET alarm_id = ? WHERE id = ?").run(alarmId, id);
  }

  const request = db.prepare<[number], SupportRequestRow>("SELECT * FROM support_requests WHERE id = ?").get(id)!;
  broadcastSupport(input.stationId);
  return { request, alarmRaised: alarmId !== null };
}

export function listSupportRequests(
  stationId: number,
  status?: "open" | "resolved",
  limit = 100
): (SupportRequestRow & { pumpNumber: number | null; resolvedByName: string | null })[] {
  const capped = Math.min(Math.max(limit, 1), 500);
  const params: (number | string)[] = [stationId];
  let where = "s.station_id = ?";
  if (status) {
    where += " AND s.status = ?";
    params.push(status);
  }
  params.push(capped);
  return db
    .prepare<(number | string)[], SupportRequestRow & { pumpNumber: number | null; resolvedByName: string | null }>(
      `SELECT s.*, p.number AS pumpNumber, u.username AS resolvedByName
       FROM support_requests s
       LEFT JOIN pumps p ON p.id = s.pump_id
       LEFT JOIN users u ON u.id = s.resolved_by
       WHERE ${where}
       ORDER BY s.created_at DESC
       LIMIT ?`
    )
    .all(...params);
}

export function countOpenSupportRequests(stationId: number): number {
  return db
    .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM support_requests WHERE station_id = ? AND status = 'open'")
    .get(stationId)!.c;
}

/** Talebi kapatir ve varsa bagli alarmi da cozer - ikisi ayri kalirsa alarm merkezi kirli birikir. */
export function resolveSupportRequest(
  id: number,
  stationId: number,
  note: string | null,
  actor: UserRow
): SupportRequestRow {
  const existing = db
    .prepare<[number, number], SupportRequestRow>("SELECT * FROM support_requests WHERE id = ? AND station_id = ?")
    .get(id, stationId);
  if (!existing) throw new SupportError("Destek talebi bulunamadi.", 404);
  if (existing.status === "resolved") throw new SupportError("Bu talep zaten kapatilmis.", 409);

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE support_requests SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?"
  ).run(actor.id, now, note?.trim() || null, id);

  if (existing.alarm_id !== null) {
    const r = db
      .prepare("UPDATE alarms SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ? AND status != 'resolved'")
      .run(actor.id, now, existing.alarm_id);
    if (r.changes > 0) broadcastAlarms(stationId);
  }

  broadcastSupport(stationId);
  return db.prepare<[number], SupportRequestRow>("SELECT * FROM support_requests WHERE id = ?").get(id)!;
}
