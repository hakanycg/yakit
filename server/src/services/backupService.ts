import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.js";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";
import { encryptFile } from "../utils/backupCrypto.js";

const BACKUP_PREFIX = "yakit-backup-";
const BACKUP_SUFFIX = ".sqlite.enc";

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * SQLite'in kendi backup API'siyle (WAL modunda bile tutarli, uygulamayi durdurmadan
 * calisan bir snapshot alir - dosyayi ham kopyalamaktan farkli olarak yarim yazilmis
 * bir sayfa yakalama riski yoktur) once GECICI bir dosyaya duz-metin yedek alinir, hemen
 * ardindan sifrelenip BACKUP_DIR'e o haliyle yazilir ve gecici duz-metin dosya silinir -
 * diskte/BACKUP_DIR'de kalan yedek HICBIR ZAMAN sifresiz durmaz (bkz. backupCrypto.ts;
 * bu yedeklerin ileride uçuncu bir tarafin - ör. bir veri merkezinin - gozetimindeki bir
 * bulut depolamaya tasinacak olmasi nedeniyle savunma-derinligi geregi eklendi).
 * BACKUP_DIR ayarlanmamissa hicbir sey yapmaz (varsayilan: yedekleme kapali).
 */
export async function runBackup(): Promise<string | null> {
  if (!env.BACKUP_DIR) return null;

  mkdirSync(env.BACKUP_DIR, { recursive: true });
  const stamp = timestampForFilename();
  const tmpPath = join(env.BACKUP_DIR, `.tmp-${stamp}.sqlite`);
  const destPath = join(env.BACKUP_DIR, `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`);

  await db.backup(tmpPath);
  try {
    encryptFile(tmpPath, destPath);
  } finally {
    unlinkSync(tmpPath);
  }
  logger.info({ destPath }, "Veritabani yedegi alindi ve sifrelendi.");

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
    try {
      unlinkSync(f.path);
      logger.info({ path: f.path }, "Eski yedek dosyasi silindi (rotasyon).");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error({ err, path: f.path }, "Eski yedek dosyasi silinemedi.");
      }
    }
  }
}
