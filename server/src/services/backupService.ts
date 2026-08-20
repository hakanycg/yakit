import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.js";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";

const BACKUP_PREFIX = "yakit-backup-";
const BACKUP_SUFFIX = ".sqlite";

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * SQLite'in kendi backup API'siyle (WAL modunda bile tutarli, uygulamayi durdurmadan
 * calisan bir snapshot alir - dosyayi ham kopyalamaktan farkli olarak yarim yazilmis
 * bir sayfa yakalama riski yoktur) belirtilen dizine zaman damgali bir yedek alir.
 * BACKUP_DIR ayarlanmamissa hicbir sey yapmaz (varsayilan: yedekleme kapali).
 */
export async function runBackup(): Promise<string | null> {
  if (!env.BACKUP_DIR) return null;

  mkdirSync(env.BACKUP_DIR, { recursive: true });
  const destPath = join(env.BACKUP_DIR, `${BACKUP_PREFIX}${timestampForFilename()}${BACKUP_SUFFIX}`);

  await db.backup(destPath);
  logger.info({ destPath }, "Veritabani yedegi alindi.");

  pruneOldBackups();
  return destPath;
}

/** BACKUP_RETENTION_COUNT'tan eski yedekleri (dosya adindaki zaman damgasina gore en yeniden en eskiye siralayip) siler. */
function pruneOldBackups(): void {
  if (!env.BACKUP_DIR) return;
  const files = readdirSync(env.BACKUP_DIR)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .map((f) => ({ name: f, path: join(env.BACKUP_DIR!, f), mtime: statSync(join(env.BACKUP_DIR!, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = files.slice(env.BACKUP_RETENTION_COUNT);
  for (const f of toDelete) {
    // Yedek dosyasi sonradan (ör. bir dogrulama/restore araciyla) WAL modunda
    // acilmissa yaninda -wal/-shm eslik dosyalari olusabilir; onlari da temizle.
    for (const path of [f.path, `${f.path}-wal`, `${f.path}-shm`]) {
      try {
        unlinkSync(path);
        logger.info({ path }, "Eski yedek dosyasi silindi (rotasyon).");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.error({ err, path }, "Eski yedek dosyasi silinemedi.");
        }
      }
    }
  }
}
