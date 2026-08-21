import express from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { countPending, enqueueEvent } from "./outboxService.js";
import { readCacheSnapshot } from "./cacheStore.js";
import { getConnectivityState } from "./connectivity.js";

const enqueueSchema = z.object({
  eventType: z.string().trim().min(1).max(60),
  payload: z.unknown().optional(),
});

/**
 * Ajanin yerel API'si - yalnizca ayni makinedeki (kiosk/pompa) yazilimlar
 * tarafindan kullanilir, dis aga acilmaz. sync_token burada YOK: bu API
 * tamamen kimliksiz/yerel guvendir, tipki localhost'taki bir IPC gibi.
 */
export function createAgentApp(db: Database.Database): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/status", (_req, res) => {
    res.json({ ...getConnectivityState(), pendingOutboxCount: countPending(db) });
  });

  app.get("/cache", (_req, res) => {
    const snapshot = readCacheSnapshot(db);
    if (!snapshot) return void res.status(404).json({ error: "Henuz onbellek cekilmedi." });
    res.json(snapshot);
  });

  app.post("/outbox", (req, res) => {
    const parsed = enqueueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Gecersiz istek.", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const { clientEventId } = enqueueEvent(db, parsed.data.eventType, parsed.data.payload);
    res.status(201).json({ clientEventId, status: "queued" });
  });

  return app;
}
