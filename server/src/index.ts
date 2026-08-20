import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env, isProd } from "./config.js";
import { logger } from "./utils/logger.js";
import { initWebSocketHub } from "./ws/hub.js";
import { purgeExpiredSessions } from "./services/sessionService.js";
import { reconcileStuckTransactions } from "./services/transactionService.js";

if (isProd && !env.COOKIE_SECURE) {
  logger.warn("UYARI: NODE_ENV=production iken COOKIE_SECURE=false. HTTPS arkasinda calisiyorsaniz bunu true yapin.");
}

/**
 * Guvenlik agi: iyzico SDK'sinin kullandigi eski HTTP istemcisi (postman-request),
 * bir baglanti kesintisinden (ör. iyzico tarafinda gecici sorun, proxy/tunnel hatasi)
 * sonra ilgili istegin kendi callback'i tamamlandiktan SONRA, soket uzerinde ayri ve
 * yakalanmamis bir 'error' (ör. ECONNRESET) olayi yayabiliyor. Bu, Node'da varsayilan
 * olarak tum sureci coktururdu — tek bir odeme denemesindeki gecici bir ag sorunu,
 * TUM istasyonlardaki kiosk/operator/yonetici erisimini kesintiye ugratirdi. Bu asla
 * kabul edilemez bir kullanilabilirlik riski oldugundan, sureci coktürmek yerine
 * hatayi loglayip calismaya devam ediyoruz.
 */
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Yakalanmamis istisna (uncaughtException) - sunucu calismaya devam ediyor.");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Yakalanmamis promise reddi (unhandledRejection) - sunucu calismaya devam ediyor.");
});

reconcileStuckTransactions();

const app = createApp();
const server = createServer(app);
initWebSocketHub(server);

const sessionCleanupInterval = setInterval(purgeExpiredSessions, 10 * 60 * 1000);
sessionCleanupInterval.unref();

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
