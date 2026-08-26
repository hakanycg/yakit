import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { db } from "../db/index.js";
import { env } from "../config.js";
import { decryptBuffer } from "../utils/backupCrypto.js";
import { createTestStation } from "../test/dbFixture.js";
import { getArchiveHealth, listArchiveFiles, readArchiveFile, runArchive } from "./archiveService.js";

/**
 * Arsivlemenin tek gercek riski VERI KAYBI: bir satirin, arsivde oldugu ISPATLANMADAN
 * canli tablodan dusulmesi. Buradaki testlerin cogu tam olarak bunu kovaliyor.
 */

const originalArchiveDir = env.ARCHIVE_DIR;
let dir: string;

function monthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

/** audit_log'a belirtilen yasta bir satir yazar ve id'sini doner. */
function seedAuditRow(createdAt: string, action = "test_action"): number {
  const r = db
    .prepare("INSERT INTO audit_log (station_id, user_id, username, action, created_at) VALUES (NULL, NULL, 'test', ?, ?)")
    .run(action, createdAt);
  return r.lastInsertRowid as number;
}

function auditRowExists(id: number): boolean {
  return db.prepare<[number], { id: number }>("SELECT id FROM audit_log WHERE id = ?").get(id) !== undefined;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archive-service-test-"));
  env.ARCHIVE_DIR = dir;
  db.prepare("DELETE FROM archive_files").run();
});

afterEach(() => {
  env.ARCHIVE_DIR = originalArchiveDir;
});

describe("arsivleme kapaliyken", () => {
  it("ARCHIVE_DIR yoksa HICBIR SATIR SILINMEZ", () => {
    // En onemli test. "Arsivleme kapali" ile "sil gitsin" ayni sey degil: arsivlenecek
    // yer yoksa satirlar yerinde kalir ve tablo buyumeye devam eder. Bunun tersi,
    // yapilandirma unutuldugu icin denetim kaydinin sessizce yok olmasi demek olurdu.
    env.ARCHIVE_DIR = undefined;
    const id = seedAuditRow(monthsAgo(60));

    const result = runArchive();

    expect(result.enabled).toBe(false);
    expect(result.totalRows).toBe(0);
    expect(auditRowExists(id)).toBe(true);
  });
});

describe("yazma basarisiz oldugunda", () => {
  it("dosya yazilamazsa HICBIR SATIR SILINMEZ", () => {
    // Silme, dogrulamadan SONRA gelir. Dizin yazilamaz durumdaysa (dolu disk, izin
    // hatasi, yanlis yapilandirilmis mount) surec dosya asamasinda patlar ve satirlar
    // yerinde kalir. Ters sirada olsaydi - once sil, sonra yaz - bir disk hatasi
    // denetim kaydini yok ederdi.
    const notADirectory = join(dir, "bu-bir-dosya");
    writeFileSync(notADirectory, Buffer.from("x"));
    env.ARCHIVE_DIR = notADirectory;

    const id = seedAuditRow(monthsAgo(60));
    const result = runArchive();

    expect(result.totalRows).toBe(0);
    expect(auditRowExists(id)).toBe(true);
    // Yarim bir dizin kaydi da kalmamali.
    expect(listArchiveFiles().length).toBe(0);
  });
});

describe("esik", () => {
  it("esikten YENI satirlara dokunmaz", () => {
    const fresh = seedAuditRow(monthsAgo(1));
    const old = seedAuditRow(monthsAgo(60));

    runArchive();

    expect(auditRowExists(fresh)).toBe(true);
    expect(auditRowExists(old)).toBe(false);
  });

  it("taban altindaki yapilandirma REDDEDILMEZ, tabana cekilir", () => {
    // 1 ay istense bile denetim kaydi tabani 12 ay. 6 aylik bir satir SILINMEMELI.
    env.ARCHIVE_AUDIT_LOG_MONTHS = 1;
    try {
      const sixMonths = seedAuditRow(monthsAgo(6));
      const twoYears = seedAuditRow(monthsAgo(25));

      runArchive();

      expect(auditRowExists(sixMonths)).toBe(true);
      expect(auditRowExists(twoYears)).toBe(false);
    } finally {
      env.ARCHIVE_AUDIT_LOG_MONTHS = undefined;
    }
  });
});

describe("arsiv dosyasi", () => {
  it("satirlari tam ve okunabilir sekilde tasir", () => {
    const id = seedAuditRow(monthsAgo(60), "arsivlenecek_eylem");

    const result = runArchive();
    const audit = result.tables.find((t) => t.table === "audit_log")!;

    expect(audit.rowCount).toBe(1);
    expect(audit.fileName).toBeTruthy();
    expect(auditRowExists(id)).toBe(false);

    // Satir gercekten geri okunabiliyor mu - "arsivlendi" demek yetmez.
    const { rows, record } = readArchiveFile(audit.fileName!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.action).toBe("arsivlenecek_eylem");
    expect(record.row_count).toBe(1);
  });

  it("diske SIFRELI yazilir - duz metin kalmaz", () => {
    // audit_log IP adresi, kullanici adi, islem detaylari tasir. Arsiv dosyasi
    // sunucudan cikip baska bir depolamaya gidecek; duz durmamali.
    seedAuditRow(monthsAgo(60), "gizli_kalmasi_gereken_eylem");
    const audit = runArchive().tables.find((t) => t.table === "audit_log")!;

    const raw = readFileSync(join(dir, audit.fileName!));
    expect(raw.includes(Buffer.from("gizli_kalmasi_gereken_eylem"))).toBe(false);
    // ...ama cozulunce orada.
    expect(gunzipSync(decryptBuffer(raw)).toString()).toContain("gizli_kalmasi_gereken_eylem");
  });

  it("yarim yazilmis gecici dosya birakmaz", () => {
    seedAuditRow(monthsAgo(60));
    runArchive();
    expect(readdirSync(dir).some((f) => f.startsWith(".tmp-"))).toBe(false);
  });

  it("dizin kaydi ile dosya ayni islemde olusur", () => {
    seedAuditRow(monthsAgo(60));
    const audit = runArchive().tables.find((t) => t.table === "audit_log")!;

    const files = listArchiveFiles();
    const record = files.find((f) => f.file_name === audit.fileName);
    expect(record).toBeTruthy();
    expect(record!.table_name).toBe("audit_log");
    expect(record!.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record!.file_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("bozulma tespiti", () => {
  it("dosyaya dokunulmussa geri okuma HATA verir - sessizce bos donmez", () => {
    seedAuditRow(monthsAgo(60));
    const audit = runArchive().tables.find((t) => t.table === "audit_log")!;

    // Dosyayi boz (ör. yanlis kopyalama, disk hatasi, kotu niyet).
    writeFileSync(join(dir, audit.fileName!), Buffer.from("bozuk icerik"));

    expect(() => readArchiveFile(audit.fileName!)).toThrow(/ozeti kayitla uyusmuyor/);
  });

  it("dizinde kayitli olmayan bir dosya okunmaz", () => {
    writeFileSync(join(dir, "sahte-arsiv.ndjson.gz.enc"), Buffer.from("x"));
    expect(() => readArchiveFile("sahte-arsiv.ndjson.gz.enc")).toThrow(/kayitli olmayan/);
  });
});

describe("tank olcumleri", () => {
  it("tank olcumleri de arsivlenir", () => {
    const station = createTestStation();
    const r = db
      .prepare(
        `INSERT INTO fuel_tank_readings
           (station_id, fuel_type, measured_liters, book_liters, variance_liters, throughput_liters, variance_pct, measured_at, source)
         VALUES (?, 'benzin', 100, 100, 0, 0, 0, ?, 'manual')`
      )
      .run(station.id, monthsAgo(24));
    const id = r.lastInsertRowid as number;

    runArchive();

    expect(
      db.prepare<[number], { id: number }>("SELECT id FROM fuel_tank_readings WHERE id = ?").get(id)
    ).toBeUndefined();
  });
});

describe("saglik gorunumu", () => {
  it("bekleyen satir sayisini bildirir - arsivleme yetisiyor mu sorusu", () => {
    seedAuditRow(monthsAgo(60));
    const before = getArchiveHealth();
    const auditBefore = before.pending.find((p) => p.table === "audit_log")!;
    expect(auditBefore.rows).toBeGreaterThanOrEqual(1);

    runArchive();

    const after = getArchiveHealth();
    expect(after.pending.find((p) => p.table === "audit_log")!.rows).toBe(0);
    expect(after.files).toBeGreaterThanOrEqual(1);
    expect(after.archivedRows).toBeGreaterThanOrEqual(1);
  });
});
