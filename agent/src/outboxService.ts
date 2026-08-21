import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface OutboxEventRow {
  id: number;
  client_event_id: string;
  event_type: string;
  payload: string | null;
  created_at: string;
  sent_at: string | null;
}

/**
 * Kiosk/pompa yazilimi bir olayi (ör. tamamlanan islem) merkez sunucuya HEMEN
 * gonderemiyorsa (baglanti kopuk), burada kaydeder ve devam eder. Arka plandaki
 * senkron donguSu (bkz. syncClient.flushOutbox) baglanti donunce bunu gonderir.
 * client_event_id, merkez sunucudaki UNIQUE(station_id, client_event_id) kisitiyla
 * eslesir - ayni olay iki kez gonderilse bile iki kez islenmez.
 */
export function enqueueEvent(db: Database.Database, eventType: string, payload: unknown): { clientEventId: string } {
  const clientEventId = randomUUID();
  db.prepare("INSERT INTO outbox_events (client_event_id, event_type, payload) VALUES (?, ?, ?)").run(
    clientEventId,
    eventType,
    JSON.stringify(payload ?? null)
  );
  return { clientEventId };
}

export function getPendingEvents(db: Database.Database, limit = 100): OutboxEventRow[] {
  return db
    .prepare<[number], OutboxEventRow>("SELECT * FROM outbox_events WHERE sent_at IS NULL ORDER BY id ASC LIMIT ?")
    .all(limit);
}

export function markSent(db: Database.Database, clientEventIds: string[]): void {
  if (clientEventIds.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare("UPDATE outbox_events SET sent_at = ? WHERE client_event_id = ?");
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(now, id);
  });
  tx(clientEventIds);
}

export function countPending(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as c FROM outbox_events WHERE sent_at IS NULL").get() as { c: number }).c;
}
