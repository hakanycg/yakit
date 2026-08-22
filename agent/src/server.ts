import express from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { countPending, enqueueEvent } from "./outboxService.js";
import { readCacheSnapshot } from "./cacheStore.js";
import { getConnectivityState } from "./connectivity.js";
import { getPrinterDriver } from "./printerDriver.js";
import { logger } from "./logger.js";

const enqueueSchema = z.object({
  eventType: z.string().trim().min(1).max(60),
  payload: z.unknown().optional(),
});

const printJobSchema = z.object({
  title: z.string().min(1).max(120),
  lines: z.array(z.object({ label: z.string().max(60), value: z.string().max(200) })).max(50),
  transactionId: z.number().int().positive(),
});

/**
 * Ajanin yerel API'si - yalnizca ayni makinedeki (kiosk/pompa) yazilimlar
 * tarafindan kullanilir, dis aga acilmaz. sync_token burada YOK: bu API
 * tamamen kimliksiz/yerel guvendir, tipki localhost'taki bir IPC gibi.
 */
export function createAgentApp(db: Database.Database): express.Express {
  const app = express();
  app.use(express.json());

  // Kiosk web uygulamasi (merkez sunucudan https ile servis edilir) ile bu yerel
  // API FARKLI origin'lerdir - tarayici CORS izni olmadan istegi engeller. Bu API
  // zaten sadece loopback'e (127.0.0.1) baglandigindan (bkz. index.ts) ve
  // cerez/oturum tasimadigindan, herhangi bir origin'e izin vermek ek bir risk
  // olusturmaz - asil guvenlik siniri ag seviyesindeki bu bağlanma kisitlamasidir.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", req.header("origin") ?? "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

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

  // Kiosk, bir islem tamamlaninca fisi ONCE buraya dener; gercek bir termal yazici
  // henuz baglanmadigindan (bkz. printerDriver.ts) su an her zaman printed:false
  // doner - kiosk bunu gorunce kendi window.print() yontemine duser. Boylece bugunku
  // davranista degisiklik olmadan, gercek donanim gelince tek yerden (setPrinterDriver)
  // devreye alinabilecek bir entegrasyon noktasi hazir olur.
  //
  // Gercek bir surucu fiziksel bir ariza (kagit bitti/sikisma/cevrimdisi) bildirirse
  // (faultCode dolu) veya print() beklenmedik sekilde reddederse, bunu sessizce
  // yutmak yerine outbox'a bir "printer_fault" olayi yazariz - baglanti donunce
  // merkez sunucuya ulasir ve orada KRITIK bir alarma donusur (bkz. syncService.ts),
  // boylece istasyon personeli yazicinin fiilen arizali oldugunu (ajanin/donanimin
  // yoklugundan degil) fark eder.
  app.post("/print", async (req, res) => {
    const parsed = printJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Gecersiz istek.", details: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const result = await getPrinterDriver().print(parsed.data);
      if (result.faultCode) {
        enqueueEvent(db, "printer_fault", { transactionId: parsed.data.transactionId, faultCode: result.faultCode });
      }
      res.json(result);
    } catch (err) {
      logger.error({ err, transactionId: parsed.data.transactionId }, "Yazici surucusu beklenmedik sekilde hata firlatti.");
      enqueueEvent(db, "printer_fault", { transactionId: parsed.data.transactionId, faultCode: "UNKNOWN" });
      res.status(500).json({ error: "Yazdirma basarisiz.", printed: false });
    }
  });

  return app;
}
