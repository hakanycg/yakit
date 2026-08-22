import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import type { FuelPriceRow, StationRow, StationSyncEventRow, StationSyncStateRow } from "../db/types.js";
import { listPumps, serializePump } from "./pumpService.js";
import { listAccounts, serializeAccount } from "./fleetService.js";
import { createAlarm } from "./alarmService.js";
import { logger } from "../utils/logger.js";

/**
 * Offline-queue mimarisi: istasyondaki yerel ajan, merkez sunucuya erisemedigi
 * kisa/orta sureli kesintilerde islem olaylarini yerel bir kuyrukta biriktirip
 * baglanti donunce buraya gonderir. Bu servis, ajanin kimlik dogrulamasini
 * (istasyon basina uretilen tek bir paylasilan sir - sync_token), olay
 * tekillestirmesini (idempotency) ve "son senkron ne zamandi" durumunu yonetir.
 */

const OFFLINE_ALARM_TYPE = "station_offline";
// Ajanin normal heartbeat araligindan (bkz. gorev #76/#77) kayda deger olcude
// buyuk tutulmali ki gecici bir tekil kesinti degil, gercek bir kesinti alarmi uretsin.
const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;

export function ensureSyncToken(stationId: number): string {
  const row = db.prepare<[number], { sync_token: string | null }>("SELECT sync_token FROM stations WHERE id = ?").get(stationId);
  if (!row) throw new Error("Istasyon bulunamadi.");
  if (row.sync_token) return row.sync_token;
  return rotateSyncToken(stationId);
}

export function rotateSyncToken(stationId: number): string {
  const token = randomBytes(24).toString("hex");
  db.prepare("UPDATE stations SET sync_token = ? WHERE id = ?").run(token, stationId);
  return token;
}

export function getStationBySyncToken(token: string): StationRow | null {
  if (!token) return null;
  const row = db.prepare<[string], StationRow>("SELECT * FROM stations WHERE sync_token = ? AND active = 1").get(token);
  return row ?? null;
}

function upsertSyncState(stationId: number, fields: { last_heartbeat_at?: string; last_synced_at?: string }): void {
  const now = new Date().toISOString();
  const existing = db.prepare<[number], StationSyncStateRow>("SELECT * FROM station_sync_state WHERE station_id = ?").get(stationId);
  if (!existing) {
    db.prepare(
      "INSERT INTO station_sync_state (station_id, last_heartbeat_at, last_synced_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(stationId, fields.last_heartbeat_at ?? null, fields.last_synced_at ?? null, now);
    return;
  }
  db.prepare(
    "UPDATE station_sync_state SET last_heartbeat_at = ?, last_synced_at = ?, updated_at = ? WHERE station_id = ?"
  ).run(fields.last_heartbeat_at ?? existing.last_heartbeat_at, fields.last_synced_at ?? existing.last_synced_at, now, stationId);
}

/** Ajanin duzenli "hayattayim" sinyali. Onceden aktif bir cevrimdisi alarmi varsa otomatik cozer. */
export function recordHeartbeat(stationId: number): void {
  upsertSyncState(stationId, { last_heartbeat_at: new Date().toISOString() });

  const activeAlarm = db
    .prepare<[number, string], { id: number }>(
      "SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
    )
    .get(stationId, OFFLINE_ALARM_TYPE);
  if (activeAlarm) {
    db.prepare("UPDATE alarms SET status = 'resolved', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), activeAlarm.id);
  }
}

export interface SyncEventInput {
  clientEventId: string;
  eventType: string;
  payload?: unknown;
}

export type SyncEventResult = { clientEventId: string; status: "stored" | "duplicate" };

/**
 * Kuyruktaki bir olayi kaydeder. client_event_id + station_id UNIQUE kisiti sayesinde
 * ayni olay baglanti kararsizligi nedeniyle tekrar gonderilirse (retry) iki kez
 * islenmez - ajan sonucu bilmeden guvenle tekrar deneyebilir.
 */
export function recordSyncEvent(stationId: number, event: SyncEventInput): SyncEventResult {
  try {
    db.prepare(
      "INSERT INTO station_sync_events (station_id, client_event_id, event_type, payload) VALUES (?, ?, ?, ?)"
    ).run(stationId, event.clientEventId, event.eventType, JSON.stringify(event.payload ?? null));
    upsertSyncState(stationId, { last_synced_at: new Date().toISOString() });
    dispatchSyncEventSideEffects(stationId, event);
    return { clientEventId: event.clientEventId, status: "stored" };
  } catch (err) {
    // UNIQUE(station_id, client_event_id) ihlali: bu olay zaten daha once islenmis.
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      return { clientEventId: event.clientEventId, status: "duplicate" };
    }
    throw err;
  }
}

/**
 * Ajanin bildirdigi bazi olay turleri, sadece kaydedilmekle kalmayip personelin
 * dikkatini gerektirir. Ikisi de ayni sekilde ele alinir: "printer_fault" (ajanin
 * GERCEK bir yazici surucusu, henuz bagli degil - bkz. gorev #97, fiziksel bir ariza
 * bildirdiginde) ve "okc_fault" (gercek bir ÖKC surucusu - henuz bagli degil, bkz.
 * gorev #101 - ayni sekilde ariza bildirdiginde). Ikisini de sessizce loglamak yerine
 * kritik bir alarma ceviririz - boylece "donanim yok" (beklenen, bugunku durum) ile
 * "donanim var ama arizali" (personelin mudahale etmesi gereken durum) ayrisir.
 */
const FAULT_EVENT_LABELS: Record<string, string> = {
  printer_fault: "Fis yazicisi",
  okc_fault: "ÖKC (yasal yazar kasa)",
};

function dispatchSyncEventSideEffects(stationId: number, event: SyncEventInput): void {
  const label = FAULT_EVENT_LABELS[event.eventType];
  if (!label) return;
  const payload = (event.payload ?? {}) as { transactionId?: number; faultCode?: string };
  logger.error({ stationId, eventType: event.eventType, payload }, "Ajan gercek donanimda fiziksel ariza bildirdi.");
  createAlarm({
    stationId,
    type: event.eventType,
    severity: "critical",
    message: `${label} arizali (kod: ${payload.faultCode ?? "UNKNOWN"})${
      payload.transactionId ? `, islem #${payload.transactionId}` : ""
    }. Musteriye fis basilamadi - musteri e-posta/SMS ile makbuz talep edebilir, ancak donanimin fiziksel olarak kontrol edilmesi gerekiyor.`,
  });
}

export function listSyncEvents(stationId: number, limit = 200): StationSyncEventRow[] {
  return db
    .prepare<[number, number], StationSyncEventRow>(
      "SELECT * FROM station_sync_events WHERE station_id = ? ORDER BY received_at DESC LIMIT ?"
    )
    .all(stationId, limit);
}

export function getSyncState(stationId: number): StationSyncStateRow | null {
  return db.prepare<[number], StationSyncStateRow>("SELECT * FROM station_sync_state WHERE station_id = ?").get(stationId) ?? null;
}

/**
 * Kiosk'un cevrimdisi modda calismaya devam edebilmesi icin ajanin periyodik
 * cektigi salt-okunur anlik goruntu: guncel yakit fiyatlari, pompa durumlari
 * ve filo hesabi bakiyeleri. Indirim kodlari kasten disaridadir - merkezi
 * dogrulama (kullanim sayisi, tarih araligi) gerektirdiginden cevrimdisi
 * modda guvenilir sekilde uygulanamaz.
 */
export function getStationCacheSnapshot(stationId: number) {
  const fuelPrices = db.prepare<[number], FuelPriceRow>("SELECT * FROM fuel_prices WHERE station_id = ?").all(stationId);
  return {
    generatedAt: new Date().toISOString(),
    fuelPrices: fuelPrices.map((p) => ({ fuelType: p.fuel_type, label: p.label, pricePerLiter: p.price_per_liter })),
    pumps: listPumps(stationId).map(serializePump),
    fleetAccounts: listAccounts(stationId)
      .filter((a) => a.active)
      .map(serializeAccount),
  };
}

/**
 * Periyodik olarak (bkz. index.ts) cagrilir: sync_token'i olusturulmus (yani
 * ajani kurulmus) ama son heartbeat'i esigi asan istasyonlar icin bir kez
 * alarm uretir. Ajan hic kurulmamis istasyonlar (station_sync_state satiri
 * olmayan) kasten atlanir - bu bir ariza degil, henuz devreye alinmamis olmaktir.
 */
export function checkOfflineStations(): void {
  const threshold = new Date(Date.now() - OFFLINE_THRESHOLD_MS).toISOString();
  const stale = db
    .prepare<[string], { station_id: number }>(
      `SELECT station_id FROM station_sync_state
       WHERE last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?`
    )
    .all(threshold);

  for (const row of stale) {
    const activeAlarm = db
      .prepare<[number, string], { id: number }>(
        "SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status = 'active' LIMIT 1"
      )
      .get(row.station_id, OFFLINE_ALARM_TYPE);
    if (activeAlarm) continue;
    try {
      createAlarm({
        stationId: row.station_id,
        type: OFFLINE_ALARM_TYPE,
        severity: "warning",
        message: "Istasyon ajaniyla son 15 dakikadir haberlesilemiyor - baglanti kesintisi olabilir.",
      });
    } catch (err) {
      logger.error({ err, stationId: row.station_id }, "Istasyon cevrimdisi alarmi olusturulamadi.");
    }
  }
}
