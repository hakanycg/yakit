import express from "express";
import helmet from "helmet";
import cors from "cors";
import pinoHttp from "pino-http";
import { env, isProd } from "./config.js";
import { logger } from "./utils/logger.js";
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
      allowedHeaders: ["Content-Type", "X-CSRF-Token", "X-Kiosk-Token"],
    })
  );

  app.use(express.json({ limit: "64kb" }));
  app.use(pinoHttp({ logger, autoLogging: !isProd }));
  app.use(attachSession);
  app.use("/api", apiRateLimit);

  app.get("/api/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

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

  app.use("/api", notFoundHandler);
  app.use(errorHandler);

  return app;
}
