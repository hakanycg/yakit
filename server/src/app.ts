import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import pinoHttp from "pino-http";
import { env, isProd } from "./config.js";
import { logger } from "./utils/logger.js";
import { db } from "./db/index.js";
import { attachSession } from "./middleware/auth.js";
import { apiRateLimit } from "./middleware/rateLimit.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/auth.js";
import { kioskRouter } from "./routes/kiosk.js";
import { pumpsRouter } from "./routes/pumps.js";
import { transactionsRouter } from "./routes/transactions.js";
import { alarmsRouter } from "./routes/alarms.js";
import { usersRouter } from "./routes/users.js";
import { auditLogRouter } from "./routes/auditLog.js";
import { settingsRouter } from "./routes/settings.js";
import { reportsRouter } from "./routes/reports.js";
import { stationsRouter } from "./routes/stations.js";
import { shiftsRouter } from "./routes/shifts.js";
import { fuelStockRouter } from "./routes/fuelStock.js";
import { loyaltyRouter } from "./routes/loyalty.js";
import { discountCodesRouter } from "./routes/discountCodes.js";
import { fleetAccountsRouter } from "./routes/fleetAccounts.js";
import { syncRouter } from "./routes/sync.js";
import { kvkkRouter } from "./routes/kvkk.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Uretimde web/ ayri bir Vite dev sunucusunda degil, derlenmis statik dosyalar
// olarak bu Express sunucusundan servis edilir - ayri bir origin/CORS/cookie-domain
// karmasasi olmadan tek adres/tek surecte calisabilsin diye.
const WEB_DIST = path.resolve(__dirname, "../../web/dist");

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: isProd ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
      hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    })
  );

  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-CSRF-Token", "X-Kiosk-Token", "X-Station-Sync-Token"],
    })
  );

  app.use(express.json({ limit: "64kb" }));
  app.use(pinoHttp({ logger, autoLogging: !isProd }));
  app.use(attachSession);
  app.use("/api", apiRateLimit);

  app.get("/api/health", (_req, res) => {
    let dbOk = true;
    try {
      // Trivial okuma sorgusu: baglanti/dosya kilidi sorunlarini gercekten yakalar,
      // sadece surecin ayakta olup olmadigini degil.
      db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    const status = dbOk ? "ok" : "degraded";
    res.status(dbOk ? 200 : 503).json({ status, dbOk, uptimeSeconds: Math.round(process.uptime()), time: new Date().toISOString() });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/kiosk", kioskRouter);
  app.use("/api/pumps", pumpsRouter);
  app.use("/api/transactions", transactionsRouter);
  app.use("/api/alarms", alarmsRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/audit-log", auditLogRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/stations", stationsRouter);
  app.use("/api/shifts", shiftsRouter);
  app.use("/api/fuel-stock", fuelStockRouter);
  app.use("/api/loyalty", loyaltyRouter);
  app.use("/api/discount-codes", discountCodesRouter);
  app.use("/api/fleet-accounts", fleetAccountsRouter);
  app.use("/api/sync", syncRouter);
  app.use("/api/kvkk", kvkkRouter);

  app.use("/api", notFoundHandler);

  if (isProd && existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    // React Router (SPA) icin: /api ve /ws disindaki tum GET istekleri index.html'e
    // duser, client-side routing yenilenen sayfalarda (ör. dogrudan /kiosk/:slug
    // acilmasinda) 404 vermez.
    app.get(/^(?!\/api|\/ws).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST, "index.html"));
    });
  } else if (isProd) {
    logger.warn({ WEB_DIST }, "Uretim modu ama web/dist bulunamadi - once 'npm run build' calistirilmali.");
  }

  app.use(errorHandler);

  return app;
}
