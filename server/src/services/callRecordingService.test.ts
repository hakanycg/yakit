import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../config.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import type { StationRow, UserRow } from "../db/types.js";
import {
  CallRecordingError,
  getRecordingById,
  getRetentionDays,
  isCallRecordingEnabled,
  listRecordings,
  readRecordingFile,
  saveRecording,
  setRetentionDays,
  sweepCallRecordings,
  sweepStationRecordings,
} from "./callRecordingService.js";

let station: StationRow;
let actor: UserRow;

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
});

describe("isCallRecordingEnabled / saveRecording opt-in", () => {
  const originalDir = env.INTERCOM_RECORDING_DIR;
  afterEach(() => {
    env.INTERCOM_RECORDING_DIR = originalDir;
  });

  it("INTERCOM_RECORDING_DIR ayarlanmamissa devre disidir ve kayit reddedilir", () => {
    env.INTERCOM_RECORDING_DIR = undefined;
    expect(isCallRecordingEnabled()).toBe(false);
    expect(() =>
      saveRecording({
        stationId: station.id,
        callId: "call-1",
        kioskId: 1,
        pumpId: null,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        mimeType: "audio/webm",
        buffer: Buffer.from("ses-verisi"),
        recordedBy: actor,
      })
    ).toThrow(CallRecordingError);
  });
});

describe("saveRecording / readRecordingFile", () => {
  const originalDir = env.INTERCOM_RECORDING_DIR;

  beforeEach(() => {
    env.INTERCOM_RECORDING_DIR = mkdtempSync(join(tmpdir(), "call-recording-test-"));
  });
  afterEach(() => {
    env.INTERCOM_RECORDING_DIR = originalDir;
  });

  it("sesi sifreli olarak diske yazar ve geri okurken duz metne cozer", () => {
    const plain = Buffer.from("gizli-ses-verisi-12345");
    const row = saveRecording({
      stationId: station.id,
      callId: "call-abc",
      kioskId: 7,
      pumpId: 2,
      startedAt: "2026-01-01T10:00:00.000Z",
      endedAt: "2026-01-01T10:02:00.000Z",
      mimeType: "audio/webm",
      buffer: plain,
      recordedBy: actor,
    });

    expect(row.station_id).toBe(station.id);
    expect(row.call_id).toBe("call-abc");
    expect(row.size_bytes).toBe(plain.length);

    const filesOnDisk = readdirSync(env.INTERCOM_RECORDING_DIR!);
    expect(filesOnDisk).toHaveLength(1);
    // Diskteki dosya sifreli olmali - duz metin asla gorunmemeli.
    expect(filesOnDisk[0]).not.toBe(plain.toString());

    const decrypted = readRecordingFile(row);
    expect(decrypted.equals(plain)).toBe(true);
  });

  it("ayni callId icin ikinci yuklemeyi reddeder", () => {
    const input = {
      stationId: station.id,
      callId: "call-dup",
      kioskId: null,
      pumpId: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      mimeType: "audio/webm",
      buffer: Buffer.from("x"),
      recordedBy: actor,
    };
    saveRecording(input);
    expect(() => saveRecording(input)).toThrow(CallRecordingError);
  });

  it("bos kaydi reddeder", () => {
    expect(() =>
      saveRecording({
        stationId: station.id,
        callId: "call-empty",
        kioskId: null,
        pumpId: null,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        mimeType: "audio/webm",
        buffer: Buffer.alloc(0),
        recordedBy: actor,
      })
    ).toThrow(CallRecordingError);
  });

  it("getRecordingById baska istasyonun kaydini dondurmez (IDOR)", () => {
    const other = createTestStation();
    const row = saveRecording({
      stationId: station.id,
      callId: "call-idor",
      kioskId: null,
      pumpId: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      mimeType: "audio/webm",
      buffer: Buffer.from("x"),
      recordedBy: actor,
    });

    expect(() => getRecordingById(row.id, other.id)).toThrow(CallRecordingError);
    expect(getRecordingById(row.id, station.id).id).toBe(row.id);
  });

  it("listRecordings istasyona gore filtreler ve toplam sayiyi doner", () => {
    const other = createTestStation();
    saveRecording({
      stationId: station.id,
      callId: "call-list-1",
      kioskId: null,
      pumpId: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      mimeType: "audio/webm",
      buffer: Buffer.from("x"),
      recordedBy: actor,
    });
    saveRecording({
      stationId: other.id,
      callId: "call-list-2",
      kioskId: null,
      pumpId: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      mimeType: "audio/webm",
      buffer: Buffer.from("x"),
      recordedBy: actor,
    });

    const { recordings, total } = listRecordings(station.id, 50, 0);
    expect(total).toBe(1);
    expect(recordings).toHaveLength(1);
    expect(recordings[0]!.call_id).toBe("call-list-1");
  });
});

describe("saklama suresi (retention)", () => {
  it("varsayilan 180 gundur, gecerli araliktaki bir deger ayarlanabilir", () => {
    expect(getRetentionDays(station.id)).toBe(180);
    setRetentionDays(station.id, 90, actor);
    expect(getRetentionDays(station.id)).toBe(90);
  });

  it("gecersiz bir deger (alt/ust sinir disi) reddedilir", () => {
    expect(() => setRetentionDays(station.id, 10, actor)).toThrow(CallRecordingError);
    expect(() => setRetentionDays(station.id, 5000, actor)).toThrow(CallRecordingError);
  });
});

describe("sweepStationRecordings / sweepCallRecordings", () => {
  const originalDir = env.INTERCOM_RECORDING_DIR;

  beforeEach(() => {
    env.INTERCOM_RECORDING_DIR = mkdtempSync(join(tmpdir(), "call-recording-sweep-test-"));
  });
  afterEach(() => {
    env.INTERCOM_RECORDING_DIR = originalDir;
  });

  it("saklama suresini asan kaydi hem diskten hem veritabanindan siler", () => {
    setRetentionDays(station.id, 30, actor);
    const row = saveRecording({
      stationId: station.id,
      callId: "call-old",
      kioskId: null,
      pumpId: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      mimeType: "audio/webm",
      buffer: Buffer.from("x"),
      recordedBy: actor,
    });
    const filePath = join(env.INTERCOM_RECORDING_DIR!, row.file_name);
    expect(existsSync(filePath)).toBe(true);

    const future = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const result = sweepStationRecordings(station.id, future);

    expect(result.deletedCount).toBe(1);
    expect(existsSync(filePath)).toBe(false);
    expect(() => getRecordingById(row.id, station.id)).toThrow(CallRecordingError);
  });

  it("saklama suresi icindeki kaydi silmez", () => {
    setRetentionDays(station.id, 180, actor);
    const row = saveRecording({
      stationId: station.id,
      callId: "call-fresh",
      kioskId: null,
      pumpId: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      mimeType: "audio/webm",
      buffer: Buffer.from("x"),
      recordedBy: actor,
    });

    const result = sweepStationRecordings(station.id, new Date());
    expect(result.deletedCount).toBe(0);
    expect(getRecordingById(row.id, station.id).id).toBe(row.id);
  });

  it("ozellik devre disiyken sweepCallRecordings hicbir sey yapmaz", () => {
    env.INTERCOM_RECORDING_DIR = undefined;
    expect(sweepCallRecordings()).toEqual([]);
  });
});
