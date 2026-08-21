import type Database from "better-sqlite3";
import { getPendingEvents, markSent } from "./outboxService.js";
import { saveCacheSnapshot } from "./cacheStore.js";
import { markOffline, markOnline } from "./connectivity.js";
import { logger } from "./logger.js";

const EVENTS_BATCH_SIZE = 100;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function callCentral(baseUrl: string, token: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: { ...init?.headers, "Content-Type": "application/json", "X-Station-Sync-Token": token },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  return res.json();
}

export async function sendHeartbeat(baseUrl: string, token: string): Promise<void> {
  try {
    await callCentral(baseUrl, token, "/api/sync/heartbeat", { method: "POST" });
    markOnline();
  } catch (err) {
    markOffline(errorMessage(err));
    logger.warn({ err }, "Heartbeat gonderilemedi - baglanti kesik olabilir.");
  }
}

/** Kuyruktaki gonderilmemis olaylari toplu halde merkeze gonderir; basarili/duplicate olanlari yerel olarak "gonderildi" isaretler. */
export async function flushOutbox(db: Database.Database, baseUrl: string, token: string): Promise<{ sent: number }> {
  const pending = getPendingEvents(db, EVENTS_BATCH_SIZE);
  if (pending.length === 0) return { sent: 0 };

  try {
    const body = {
      events: pending.map((e) => ({ clientEventId: e.client_event_id, eventType: e.event_type, payload: JSON.parse(e.payload ?? "null") })),
    };
    const res = (await callCentral(baseUrl, token, "/api/sync/events", { method: "POST", body: JSON.stringify(body) })) as {
      results: Array<{ clientEventId: string; status: "stored" | "duplicate" }>;
    };
    markOnline();
    // Hem "stored" hem "duplicate" merkez tarafinda kalici olarak islenmis demektir;
    // ikisi de yerelde tekrar denemeyi durdurmak icin "gonderildi" sayilmali.
    markSent(db, res.results.map((r) => r.clientEventId));
    return { sent: res.results.length };
  } catch (err) {
    markOffline(errorMessage(err));
    logger.warn({ err, pendingCount: pending.length }, "Outbox gonderilemedi - bir sonraki denemede tekrar denenecek.");
    return { sent: 0 };
  }
}

export async function pullCache(db: Database.Database, baseUrl: string, token: string): Promise<void> {
  try {
    const snapshot = await callCentral(baseUrl, token, "/api/sync/station-cache");
    saveCacheSnapshot(db, snapshot);
    markOnline();
  } catch (err) {
    markOffline(errorMessage(err));
    logger.warn({ err }, "Onbellek cekilemedi - yerelde onceki onbellek kullanilmaya devam edilecek.");
  }
}
