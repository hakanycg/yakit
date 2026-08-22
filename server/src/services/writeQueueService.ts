import { db } from "../db/index.js";
import type { WriteQueueRow } from "../db/types.js";
import { logger } from "../utils/logger.js";

/**
 * Dayanikli (durable) yazma kuyrugu - Kafka/RabbitMQ'nun bu uygulamadaki islevsel
 * karsiligi: ayri bir broker servisi/maliyet gerektirmeden, uygulamanin zaten
 * kullandigi SQLite'i kullanir. Amac ayni: yavas/agin BASARISIZ OLABILEN bir isi
 * (ör. e-posta/SMS gonderimi) cagiran taraf BEKLEMEDEN kabul etmek, ve o is
 * sunucu coksede/ag gecici olarak kesilse de SESSIZCE KAYBOLMAMASINI saglamak.
 *
 * Akis: enqueueWrite() isi hemen (senkron, hizli) diske yazar ve doner - cagiran
 * taraf bloklanmaz. Arka planda periyodik calisan processWriteQueue() (bkz.
 * index.ts) bekleyen kayitlari sirayla isler; basarisiz olursa MAX_ATTEMPTS'e
 * kadar bir sonraki turda tekrar dener. Sunucu processWriteQueue() calisirken
 * coker ve yeniden baslarsa, henuz islenmemis (processed_at IS NULL) kayitlar
 * veritabaninda durur ve bir sonraki calismada otomatik olarak islenir - hicbir
 * ozel "kurtarma" adimina gerek yoktur.
 */

export type WriteQueueHandler = (payload: unknown) => void | Promise<void>;

const handlers = new Map<string, WriteQueueHandler>();

/** Bir is turunu (kind) gercekten isleyecek fonksiyonu kaydeder. Genelde ilgili servisin (ör. alarmService.ts) modul yuklenirken bir kez cagrilir. */
export function registerWriteQueueHandler(kind: string, handler: WriteQueueHandler): void {
  handlers.set(kind, handler);
}

/** Sadece testler icin: kayitli handler'lari sifirlar. */
export function resetWriteQueueHandlers(): void {
  handlers.clear();
}

/** Kabul adimi: senkron ve hizlidir, cagiran taraf yavas isleme adimini beklemez. Eklenen satirin id'sini dondurur (ör. testlerde/tanilamada izlemek icin). */
export function enqueueWrite(kind: string, payload: unknown): number {
  const result = db.prepare("INSERT INTO write_queue (kind, payload) VALUES (?, ?)").run(kind, JSON.stringify(payload ?? null));
  return result.lastInsertRowid as number;
}

/** Testler/tanilama icin: tek bir kuyruk kaydini id ile getirir. */
export function getWriteQueueRow(id: number): WriteQueueRow | null {
  return db.prepare<[number], WriteQueueRow>("SELECT * FROM write_queue WHERE id = ?").get(id) ?? null;
}

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;

/** Periyodik olarak (bkz. index.ts) bekleyen kayitlari sirayla isler. */
export async function processWriteQueue(): Promise<void> {
  const rows = db
    .prepare<[number], WriteQueueRow>("SELECT * FROM write_queue WHERE processed_at IS NULL ORDER BY id ASC LIMIT ?")
    .all(BATCH_SIZE);

  for (const row of rows) {
    const handler = handlers.get(row.kind);
    if (!handler) {
      // Bilinmeyen bir is turu (ör. eski bir surumden kalma) - islenmis say, sonsuza dek takilip kalmasin.
      db.prepare("UPDATE write_queue SET processed_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
      continue;
    }
    try {
      await handler(JSON.parse(row.payload));
      db.prepare("UPDATE write_queue SET processed_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= MAX_ATTEMPTS) {
        logger.error({ err, kind: row.kind, id: row.id, attempts }, "Kuyruk kaydi azami deneme sayisina ulasti, vazgeciliyor.");
        db.prepare("UPDATE write_queue SET processed_at = ?, attempts = ?, last_error = ? WHERE id = ?").run(
          new Date().toISOString(),
          attempts,
          message,
          row.id
        );
      } else {
        logger.warn({ err, kind: row.kind, id: row.id, attempts }, "Kuyruk kaydi islenemedi, bir sonraki turda tekrar denenecek.");
        db.prepare("UPDATE write_queue SET attempts = ?, last_error = ? WHERE id = ?").run(attempts, message, row.id);
      }
    }
  }
}

/** Islenmis (basarili veya vazgecilmis) eski kayitlari temizler - tablo sonsuza dek buyumesin. */
export function pruneWriteQueue(olderThanMs = 7 * 24 * 60 * 60 * 1000): void {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  db.prepare("DELETE FROM write_queue WHERE processed_at IS NOT NULL AND processed_at < ?").run(cutoff);
}

/** Testler/tanilama icin: bekleyen kayit sayisi. */
export function countPendingWrites(): number {
  return (db.prepare("SELECT COUNT(*) as c FROM write_queue WHERE processed_at IS NULL").get() as { c: number }).c;
}
