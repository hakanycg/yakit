import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env, isProd } from "./config.js";
import { logger } from "./utils/logger.js";
import { initWebSocketHub } from "./ws/hub.js";
import { purgeExpiredSessions } from "./services/sessionService.js";
import { reconcileStuckTransactions } from "./services/transactionService.js";
import { maybeRunScheduledSync } from "./services/fuelSyncService.js";

if (isProd && !env.COOKIE_SECURE) {
  logger.warn("UYARI: NODE_ENV=production iken COOKIE_SECURE=false. HTTPS arkasinda calisiyorsaniz bunu true yapin.");
}

reconcileStuckTransactions();

const app = createApp();
const server = createServer(app);
initWebSocketHub(server);

const sessionCleanupInterval = setInterval(purgeExpiredSessions, 10 * 60 * 1000);
sessionCleanupInterval.unref();

const fuelSyncInterval = setInterval(() => {
  maybeRunScheduledSync().catch((err) => logger.error({ err }, "Zamanlanmis yakit fiyati senkronizasyonu basarisiz."));
}, 5 * 60 * 1000);
fuelSyncInterval.unref();
maybeRunScheduledSync().catch((err) => logger.error({ err }, "Baslangic yakit fiyati senkronizasyonu basarisiz."));

server.listen(env.PORT, () => {
  logger.info(`Yakit istasyonu API sunucusu ${env.PORT} portunda calisiyor (${env.NODE_ENV}).`);
});

function shutdown(signal: string) {
  logger.info(`${signal} alindi, sunucu kapatiliyor...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
