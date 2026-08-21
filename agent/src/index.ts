import { env } from "./config.js";
import { openAgentDb } from "./db.js";
import { createAgentApp } from "./server.js";
import { flushOutbox, pullCache, sendHeartbeat } from "./syncClient.js";
import { logger } from "./logger.js";

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Yakalanmamis istisna - ajan calismaya devam ediyor.");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Yakalanmamis promise reddi - ajan calismaya devam ediyor.");
});

const db = openAgentDb(env.LOCAL_DB_PATH);

sendHeartbeat(env.CENTRAL_API_URL, env.STATION_SYNC_TOKEN);
const heartbeatInterval = setInterval(() => sendHeartbeat(env.CENTRAL_API_URL, env.STATION_SYNC_TOKEN), env.HEARTBEAT_INTERVAL_MS);
heartbeatInterval.unref();

flushOutbox(db, env.CENTRAL_API_URL, env.STATION_SYNC_TOKEN);
const outboxInterval = setInterval(() => flushOutbox(db, env.CENTRAL_API_URL, env.STATION_SYNC_TOKEN), env.OUTBOX_FLUSH_INTERVAL_MS);
outboxInterval.unref();

pullCache(db, env.CENTRAL_API_URL, env.STATION_SYNC_TOKEN);
const cacheInterval = setInterval(() => pullCache(db, env.CENTRAL_API_URL, env.STATION_SYNC_TOKEN), env.CACHE_PULL_INTERVAL_MS);
cacheInterval.unref();

const app = createAgentApp(db);
// Bu yerel API kimliksizdir (bkz. server.ts yorumu) - ayni makine disina ASLA
// acilmamali. Varsayilan app.listen(port) tum aglara (0.0.0.0) baglanirdi; ayni
// yerel agdaki baska bir cihazin outbox'a sahte olay enjekte edebilmesini veya
// /cache uzerinden filo bakiyeleri gibi ticari verileri okuyabilmesini onlemek
// icin acikca sadece loopback'e (127.0.0.1) baglaniyoruz.
const server = app.listen(env.PORT, "127.0.0.1", () => {
  logger.info(`Istasyon ajani ${env.PORT} portunda (yalnizca localhost) calisiyor (merkez: ${env.CENTRAL_API_URL}).`);
});

function shutdown(signal: string) {
  logger.info(`${signal} alindi, ajan kapatiliyor...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
