import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.js";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";
import { decryptFile } from "../utils/backupCrypto.js";
import { createAlarm } from "./alarmService.js";

/**
 * Yedek dogrulama - geri yukleme tatbikati.
 *
 * Yedekler aliniyor, sifreleniyor ve rotasyona giriyordu; ama hicbir asamada
 * DOGRULANMIYORDU. Sifresi cozulebiliyor mu, gecerli bir SQLite dosyasi mi, icinde veri
 * var mi - kimse bakmiyordu. Sifreleme anahtari degistiginde, yazma yarim kaldiginda ya
 * da dosya bozuldugunda bu ancak felaket gununde anlasilirdi.
 *
 * Hic geri yuklenmemis bir yedek, yedek DEGILDIR. Bu servis her yedekten sonra yedegi
 * gercekten acar ve okur; basarisiz olursa KRITIK ALARM uretir - amac sorunu bugun
 * ogrenmek, ihtiyac duyuldugu gun degil.
 */

const BACKUP_PREFIX = "yakit-backup-";
const BACKUP_SUFFIX = ".sqlite.enc";

/**
 * Yedegin icinde bulunmasi beklenen tablolar. Tamami degil, sistemin CALISMASI icin
 * vazgecilmez olanlar: bunlardan biri eksikse elde bir SQLite dosyasi vardir ama
 * kullanilabilir bir yedek yoktur.
 */
const REQUIRED_TABLES = ["stations", "users", "roles", "pumps", "transactions", "fuel_prices", "fuel_tanks"];

export interface BackupVerificationTable {
  table: string;
  backupRows: number;
  liveRows: number;
}

export interface BackupVerification {
  ok: boolean;
  path: string;
  sizeBytes: number;
  /** Basarisizlik sebebi - ok=false ise doludur. */
  error: string | null;
  integrityCheck: string | null;
  missingTables: string[];
  tables: BackupVerificationTable[];
  durationMs: number;
  verifiedAt: string;
}

export function listBackups(): string[] {
  if (!env.BACKUP_DIR || !existsSync(env.BACKUP_DIR)) return [];
  return readdirSync(env.BACKUP_DIR)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .map((f) => join(env.BACKUP_DIR!, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function latestBackupPath(): string | null {
  return listBackups()[0] ?? null;
}

function liveRowCount(table: string): number {
  try {
    return db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get()!.c;
  } catch {
    return 0;
  }
}

/**
 * Yedegi gercekten acip okur.
 *
 * Cozulmus (duz-metin) gecici dosya try/finally ile HER DURUMDA silinir: yedeklerin
 * diskte sifresiz durmamasi zaten bu ozelligin varlik sebebiydi (bkz. backupCrypto.ts),
 * dogrulamanin kendisi o kurali delemez.
 */
export function verifyBackup(path: string): BackupVerification {
  const startedAt = Date.now();
  const base: Omit<BackupVerification, "ok" | "error"> = {
    path,
    sizeBytes: existsSync(path) ? statSync(path).size : 0,
    integrityCheck: null,
    missingTables: [],
    tables: [],
    durationMs: 0,
    verifiedAt: new Date().toISOString(),
  };

  const fail = (error: string): BackupVerification => ({
    ...base,
    ok: false,
    error,
    durationMs: Date.now() - startedAt,
  });

  if (!existsSync(path)) return fail("Yedek dosyasi bulunamadi.");
  if (base.sizeBytes === 0) return fail("Yedek dosyasi bos.");

  mkdirSync(env.BACKUP_DIR!, { recursive: true });
  const tmpPath = join(env.BACKUP_DIR!, `.verify-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  let handle: Database.Database | null = null;

  try {
    try {
      decryptFile(path, tmpPath);
    } catch (err) {
      // En sinsi senaryo bu: anahtar degismisse dosyalar diskte durur, boyutlari
      // dogrudur, ama hicbiri acilamaz.
      return fail(`Yedegin sifresi cozulemedi (anahtar degismis olabilir): ${err instanceof Error ? err.message : "bilinmeyen hata"}`);
    }

    try {
      handle = new Database(tmpPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      return fail(`Yedek gecerli bir SQLite veritabani degil: ${err instanceof Error ? err.message : "bilinmeyen hata"}`);
    }

    // better-sqlite3 dosyayi ACARKEN icerigi dogrulamaz; "bu bir veritabani degil"
    // hatasi ilk sorguda gelir. Bu yuzden pragma da korumali cagrilir.
    let integrity: string;
    try {
      integrity = handle.pragma("integrity_check", { simple: true }) as string;
    } catch (err) {
      return fail(`Yedek gecerli bir SQLite veritabani degil: ${err instanceof Error ? err.message : "bilinmeyen hata"}`);
    }
    base.integrityCheck = integrity;
    if (integrity !== "ok") return fail(`Yedegin butunluk kontrolu basarisiz: ${integrity}`);

    const tableNames = new Set(
      handle.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    base.missingTables = REQUIRED_TABLES.filter((t) => !tableNames.has(t));
    if (base.missingTables.length > 0) {
      return fail(`Yedekte olmasi gereken tablolar eksik: ${base.missingTables.join(", ")}`);
    }

    for (const table of REQUIRED_TABLES) {
      const backupRows = handle.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get()!.c;
      base.tables.push({ table, backupRows, liveRows: liveRowCount(table) });
    }

    // Canli veritabaninda veri olan bir tablo yedekte BOSSA yedek kullanilamaz.
    // Esitlik ARANMAZ: yedek birkac saniye/saat onceki anlik goruntudur, satir
    // sayilarinin birebir tutmasini beklemek surekli yanlis alarm uretirdi.
    const empty = base.tables.filter((t) => t.liveRows > 0 && t.backupRows === 0);
    if (empty.length > 0) {
      return fail(`Yedekte veri beklenen tablolar bos: ${empty.map((t) => t.table).join(", ")}`);
    }

    return { ...base, ok: true, error: null, durationMs: Date.now() - startedAt };
  } finally {
    handle?.close();
    // SQLite'i acmak yaninda -wal ve -shm yan dosyalarini da olusturur ve bunlar da
    // COZULMUS veritabani icerigi tasir. Yalnizca ana dosyayi silmek, sifrelemenin
    // engellemek icin var oldugu seyi diskte birakmak demek olurdu.
    for (const f of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch (err) {
        // Cozulmus yedek diskte kalirsa bu bir GUVENLIK sorunudur, sessizce gecilemez.
        logger.error({ err, path: f }, "Dogrulama icin cozulen gecici yedek dosyasi silinemedi.");
      }
    }
  }
}

let lastVerification: BackupVerification | null = null;

/** Saglik ucu ve panel icin: en son dogrulama sonucu. */
export function getLastVerification(): BackupVerification | null {
  return lastVerification;
}

const FAILURE_ALARM_TYPE = "backup_verification_failed";

/**
 * En son yedegi dogrular. Basarisizlikta kritik alarm uretir; basarili olunca varsa
 * onceki alarmi cozer - sorun giderildiginde alarmin kendiliginden kapanmasi, operatorun
 * elle temizlemesi gereken bir kalinti birakmamak icindir (ayni desen: dusuk stok).
 *
 * Hangi istasyona alarm yazilir? Yedek TUM sisteme aittir, tek bir istasyona degil; bu
 * yuzden en dusuk id'li aktif istasyon secilir - alarm merkezi istasyon bazli oldugu
 * icin bir yere yazilmasi gerekiyor ve bunun kesin bir dogru cevabi yok. Mesajda bunun
 * sistem geneli bir uyari oldugu acikca yazar.
 */
export function verifyLatestBackup(): BackupVerification | null {
  if (!env.BACKUP_DIR) return null;
  const path = latestBackupPath();
  if (!path) return null;

  const result = verifyBackup(path);
  lastVerification = result;

  const station = db.prepare<[], { id: number }>("SELECT id FROM stations WHERE active = 1 ORDER BY id LIMIT 1").get();
  if (!station) return result;

  const existing = db
    .prepare<[number, string], { id: number }>(
      "SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved' LIMIT 1"
    )
    .get(station.id, FAILURE_ALARM_TYPE);

  if (result.ok) {
    if (existing) {
      db.prepare("UPDATE alarms SET status = 'resolved', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
    }
    logger.info({ path, durationMs: result.durationMs }, "Yedek dogrulandi.");
    return result;
  }

  logger.error({ path, error: result.error }, "YEDEK DOGRULANAMADI.");
  // Alarm zaten aciksa tekrar uretilmez; her yedek turunda yeni bir alarm acmak
  // alarm merkezini doldurur ve yukseltme mantigini da bozardi.
  if (!existing) {
    createAlarm({
      stationId: station.id,
      type: FAILURE_ALARM_TYPE,
      severity: "critical",
      message: `SISTEM GENELI: en son veritabani yedegi dogrulanamadi. ${result.error} Dosya: ${path}`,
    });
  }
  return result;
}
