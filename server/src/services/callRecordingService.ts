import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.js";
import { env } from "../config.js";
import { encryptBuffer, decryptBuffer } from "../utils/backupCrypto.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { logger } from "../utils/logger.js";
import type { CallRecordingRow, UserRow } from "../db/types.js";

/**
 * Interkom cagri kaydi (TS 12820 madde 4.9.3.5 kapsamindaki musteri<->gorevli sesli
 * gorusmenin GUVENLIK amacli saklanmasi - is talebi uzerine eklendi).
 *
 * Kayit MUTLAKA gorevli (operator) tarafinda alinir - kiosk her zaman ARAYAN, gorevli
 * her zaman YANITLAYAN taraftir (bkz. web/src/shared/useIntercomCall.ts), yani gorevlinin
 * tarayicisi her cagride var olan TEK deterministik/kimligi dogrulanmis uctur. Tarayici
 * yerel mikrofon + WebRTC uzak sesi Web Audio API ile karistirip MediaRecorder ile
 * kaydeder, cagri bitince tek bir ses dosyasi olarak buraya yukler (bkz.
 * routes/intercomRecordings.ts POST /).
 *
 * Sifreleme: backupService.ts ile AYNI ilke (defense-in-depth) - ses, bir gercek kisinin
 * SESI oldugundan (KVKK'da ozel nitelikli olmasa da yuksek hassasiyetli bir kisisel veri),
 * diskte DAIMA sifreli durur (encryptBuffer/decryptBuffer, backupCrypto.ts). Devre disi
 * varsayilan: INTERCOM_RECORDING_DIR bos birakilirsa (varsayilan) ozellik tamamen
 * kapalidir - hicbir ses kaydedilmez/yuklenmez, feature yalnizca acikca yapilandirilirsa
 * calisir (BACKUP_DIR/ARCHIVE_DIR ile ayni opt-in deseni).
 */

export class CallRecordingError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export function isCallRecordingEnabled(): boolean {
  return !!env.INTERCOM_RECORDING_DIR;
}

function recordingDir(): string {
  if (!env.INTERCOM_RECORDING_DIR) {
    throw new CallRecordingError("Interkom kayit ozelligi bu sunucuda etkin degil.", 501);
  }
  return env.INTERCOM_RECORDING_DIR;
}

/** callId disaridan (kiosk) gelir - dosya adina dogrudan gomulmeden once temizlenir. */
function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

export interface SaveRecordingInput {
  stationId: number;
  callId: string;
  kioskId: number | null;
  pumpId: number | null;
  startedAt: string;
  endedAt: string;
  mimeType: string;
  buffer: Buffer;
  recordedBy: UserRow | null;
}

const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

export function saveRecording(input: SaveRecordingInput): CallRecordingRow {
  const dir = recordingDir();
  if (input.buffer.length === 0) throw new CallRecordingError("Bos ses kaydi yuklenemez.", 400);
  if (input.buffer.length > MAX_RECORDING_BYTES) throw new CallRecordingError("Ses kaydi cok buyuk.", 413);

  const existing = db
    .prepare<[string], { id: number }>("SELECT id FROM call_recordings WHERE call_id = ?")
    .get(input.callId);
  if (existing) throw new CallRecordingError("Bu cagri icin kayit zaten yuklenmis.", 409);

  mkdirSync(dir, { recursive: true });
  const fileName = `${input.stationId}-${safeFileSegment(input.callId)}.enc`;
  const path = join(dir, fileName);
  writeFileSync(path, encryptBuffer(input.buffer));

  const result = db
    .prepare(
      `INSERT INTO call_recordings
        (station_id, call_id, kiosk_id, pump_id, started_at, ended_at, file_name, mime_type, size_bytes, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.stationId,
      input.callId,
      input.kioskId,
      input.pumpId,
      input.startedAt,
      input.endedAt,
      fileName,
      input.mimeType,
      input.buffer.length,
      input.recordedBy?.id ?? null
    );

  return getRecordingById(Number(result.lastInsertRowid), input.stationId);
}

/** IDOR-safe: fuelStockService.getMovementById ile AYNI desen - id baska istasyona aitse "bulunamadi". */
export function getRecordingById(id: number, stationId: number): CallRecordingRow {
  const row = db.prepare<[number], CallRecordingRow>("SELECT * FROM call_recordings WHERE id = ?").get(id);
  if (!row || row.station_id !== stationId) throw new CallRecordingError("Kayit bulunamadi.", 404);
  return row;
}

export interface ListRecordingsResult {
  recordings: CallRecordingRow[];
  total: number;
}

export function listRecordings(stationId: number, limit: number, offset: number): ListRecordingsResult {
  const recordings = db
    .prepare<[number, number, number], CallRecordingRow>(
      "SELECT * FROM call_recordings WHERE station_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .all(stationId, limit, offset);
  const { total } = db
    .prepare<[number], { total: number }>("SELECT COUNT(*) as total FROM call_recordings WHERE station_id = ?")
    .get(stationId)!;
  return { recordings, total };
}

export function readRecordingFile(row: CallRecordingRow): Buffer {
  const dir = recordingDir();
  const path = join(dir, row.file_name);
  if (!existsSync(path)) throw new CallRecordingError("Kayit dosyasi diskte bulunamadi.", 404);
  return decryptBuffer(readFileSync(path));
}

const RETENTION_DAYS_KEY = "intercom_recording_retention_days";
const DEFAULT_RETENTION_DAYS = 180;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 1825;

export function getRetentionDays(stationId: number): number {
  const raw = getSetting(stationId, RETENTION_DAYS_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= MIN_RETENTION_DAYS && parsed <= MAX_RETENTION_DAYS
    ? parsed
    : DEFAULT_RETENTION_DAYS;
}

export function setRetentionDays(stationId: number, days: number, actor: UserRow): number {
  if (!Number.isFinite(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new CallRecordingError(`Saklama suresi ${MIN_RETENTION_DAYS} ile ${MAX_RETENTION_DAYS} gun arasinda olmalidir.`, 400);
  }
  setSetting(stationId, RETENTION_DAYS_KEY, String(days), actor);
  return days;
}

export interface RecordingSweepResult {
  stationId: number;
  deletedCount: number;
}

/**
 * KVKK saklama suresi - dataRetentionService.sweepStation ile AYNI ilke: sure dolan
 * kayit hem diskten (sifreli dosya) hem veritabanindan SILINIR (anonimlestirme degil -
 * ses zaten baska hicbir amaca hizmet etmez, sureyi asinca varlik nedeni kalmaz).
 */
export function sweepStationRecordings(stationId: number, now = new Date()): RecordingSweepResult {
  const retentionDays = getRetentionDays(stationId);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const expired = db
    .prepare<[number, string], CallRecordingRow>("SELECT * FROM call_recordings WHERE station_id = ? AND created_at < ?")
    .all(stationId, cutoff);

  let deletedCount = 0;
  for (const row of expired) {
    try {
      if (env.INTERCOM_RECORDING_DIR) {
        const path = join(env.INTERCOM_RECORDING_DIR, row.file_name);
        if (existsSync(path)) unlinkSync(path);
      }
      db.prepare("DELETE FROM call_recordings WHERE id = ?").run(row.id);
      deletedCount++;
    } catch (err) {
      logger.error({ err, recordingId: row.id }, "Interkom kaydi silinemedi.");
    }
  }
  return { stationId, deletedCount };
}

export function sweepCallRecordings(now = new Date()): RecordingSweepResult[] {
  if (!isCallRecordingEnabled()) return [];
  const stations = db.prepare<[], { id: number }>("SELECT id FROM stations WHERE active = 1").all();
  const results: RecordingSweepResult[] = [];
  for (const station of stations) {
    try {
      const result = sweepStationRecordings(station.id, now);
      if (result.deletedCount > 0) results.push(result);
    } catch (err) {
      logger.error({ err, stationId: station.id }, "Interkom kayit saklama suresi taramasi basarisiz.");
    }
  }
  return results;
}
