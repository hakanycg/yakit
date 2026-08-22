import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env, isProd } from "./config.js";
import { logger } from "./utils/logger.js";
import { initWebSocketHub } from "./ws/hub.js";
import { purgeExpiredSessions } from "./services/sessionService.js";
import { reconcileStaleCreatedTransactions, reconcileStuckTransactions } from "./services/transactionService.js";
import { maybeSendScheduledReportEmails } from "./services/reportEmailService.js";
import { runBackup } from "./services/backupService.js";
import { checkOfflineStations } from "./services/syncService.js";
import { checkSafetySensors } from "./services/safetyMonitorService.js";
import { applyDuePriceChanges } from "./services/scheduledPriceService.js";
import { encryptLegacyPlaintextSecrets } from "./utils/secretsCrypto.js";

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

// iyzico/Uyumsoft sirlarini durumda (at-rest) sifreler (bkz. secretsCrypto.ts) -
// idempotenttir, zaten sifreli satirlari atlar; her baslangicta guvenle calisir.
encryptLegacyPlaintextSecrets();

reconcileStuckTransactions();

// Odemesini hic tamamlamadan kiosk'tan ayrilan musterilerin pompayi sonsuza dek
// "reserved" tutmasini engeller (bkz. reconcileStaleCreatedTransactions yorumu). Sik
// kontrol (20sn), varsayilan 3dk esikle birlikte, pompanin gercekte kilitli kaldigi
// sureyi (en kotu ihtimalle esik + kontrol araligi) makul seviyede tutar.
reconcileStaleCreatedTransactions();
const staleTransactionInterval = setInterval(reconcileStaleCreatedTransactions, 20 * 1000);
staleTransactionInterval.unref();

const app = createApp();
const server = createServer(app);
initWebSocketHub(server);

const sessionCleanupInterval = setInterval(purgeExpiredSessions, 10 * 60 * 1000);
sessionCleanupInterval.unref();

// Istasyon ajaniyla haberlesme kesilirse (offline-queue mimarisi) alarm uretir.
// Esik 15 dakika oldugundan 5 dakikada bir kontrol yeterince hassastir.
const offlineStationInterval = setInterval(checkOfflineStations, 5 * 60 * 1000);
offlineStationInterval.unref();

// Yangin/gaz alarm sistemi (bkz. safetySensorDriver.ts) - can guvenligi soz konusu
// oldugundan cok daha sik kontrol edilir (diger periyodik islerin aksine saniyeler
// mertebesinde). Su an noop surucu ile hicbir sey yapmaz, gercek donanim baglaninca
// devreye girer.
const safetySensorInterval = setInterval(checkSafetySensors, 10 * 1000);
safetySensorInterval.unref();

// Zamanlanmis yakit fiyati degisiklikleri - dakika hassasiyeti yeterli.
applyDuePriceChanges();
const scheduledPriceInterval = setInterval(applyDuePriceChanges, 60 * 1000);
scheduledPriceInterval.unref();

// Haftalik/aylik ozet raporu e-postalari: saatlik kontrol yeterli hassasiyette
// (donem siniri gun bazinda, saniye hassasiyeti gerekmiyor). Hata durumunda
// sunucuyu etkilememesi icin catch'leniyor.
maybeSendScheduledReportEmails().catch((err) => logger.error({ err }, "Ozet raporu e-postasi gonderimi basarisiz."));
const reportEmailInterval = setInterval(() => {
  maybeSendScheduledReportEmails().catch((err) => logger.error({ err }, "Ozet raporu e-postasi gonderimi basarisiz."));
}, 60 * 60 * 1000);
reportEmailInterval.unref();

// Veritabani yedekleme: BACKUP_DIR ayarlanmamissa runBackup() no-op'tur. Sunucu
// baslarken bir kez ve ardindan BACKUP_INTERVAL_HOURS'ta bir calisir.
runBackup().catch((err) => logger.error({ err }, "Veritabani yedeklemesi basarisiz."));
const backupInterval = setInterval(() => {
  runBackup().catch((err) => logger.error({ err }, "Veritabani yedeklemesi basarisiz."));
}, env.BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
backupInterval.unref();

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
