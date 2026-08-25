import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env, isProd } from "./config.js";
import { logger } from "./utils/logger.js";
import { initWebSocketHub } from "./ws/hub.js";
import { purgeExpiredSessions } from "./services/sessionService.js";
import { purgeExpiredPortalSessions } from "./services/fleetPortalService.js";
import { reconcileStaleCreatedTransactions, reconcileStuckTransactions } from "./services/transactionService.js";
import { maybeSendScheduledReportEmails } from "./services/reportEmailService.js";
import { runBackup } from "./services/backupService.js";
import { checkOfflineStations } from "./services/syncService.js";
import { checkOfflineKiosks } from "./services/kioskFleetService.js";
import { sweepTankGauges } from "./services/tankGaugeService.js";
import { checkSafetySensors } from "./services/safetyMonitorService.js";
import { sendAutomationAliveSignals } from "./services/automationDriver.js";
import { applyDuePriceChanges } from "./services/scheduledPriceService.js";
import { encryptLegacyPlaintextSecrets } from "./utils/secretsCrypto.js";
import { processWriteQueue, pruneWriteQueue } from "./services/writeQueueService.js";
import "./services/alarmService.js"; // write-queue handler'ini (critical_alarm_notification) kaydeder

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

const sessionCleanupInterval = setInterval(() => {
  purgeExpiredSessions();
  // Filo musteri portali oturumlari ayri tablodadir; ayni temizlikten gecmezse
  // suresi dolmus satirlar sonsuza kadar birikirdi.
  purgeExpiredPortalSessions();
}, 10 * 60 * 1000);
sessionCleanupInterval.unref();

// Istasyon ajaniyla haberlesme kesilirse (offline-queue mimarisi) alarm uretir.
// Esik 15 dakika oldugundan 5 dakikada bir kontrol yeterince hassastir.
const offlineStationInterval = setInterval(checkOfflineStations, 5 * 60 * 1000);
offlineStationInterval.unref();

// Kiosk ekranlarinin kalp atisi. Personelsiz istasyonda dusmus bir kiosk, o adada hic
// satis yapilamamasi demektir ve kimse fark etmeden saatlerce boyle kalabilir. Esik
// 10 dakika oldugundan 2 dakikada bir kontrol yeterince hassastir.
const offlineKioskInterval = setInterval(() => checkOfflineKiosks(), 2 * 60 * 1000);
offlineKioskInterval.unref();

// Tank seviye probundan otomatik olcum. Prob bagli degilse (bugunku durum) surucu null
// doner ve hicbir sey kaydedilmez; asagidaki dongu bosa donmus olur. Aralik saatlik
// esikten (bkz. tankGaugeService.ts) daha sik: dolum suruyorsa okuma atlanacagindan,
// sik denemek "istasyon sakinlestigi anda oku" davranisini verir.
const tankGaugeInterval = setInterval(() => {
  try {
    sweepTankGauges();
  } catch (err) {
    logger.error({ err }, "Tank seviye probu taramasi basarisiz.");
  }
}, 10 * 60 * 1000);
tankGaugeInterval.unref();

// Yangin/gaz alarm sistemi (bkz. safetySensorDriver.ts) - can guvenligi soz konusu
// oldugundan cok daha sik kontrol edilir (diger periyodik islerin aksine saniyeler
// mertebesinde). Su an noop surucu ile hicbir sey yapmaz, gercek donanim baglaninca
// devreye girer.
const safetySensorInterval = setInterval(checkSafetySensors, 10 * 1000);
safetySensorInterval.unref();

// IOS otomasyon failsafe/dead-man's-switch sinyali (bkz. automationDriver.ts) - gercek bir
// IOS kutusu baglaninca bu periyodik cagri kesilirse kutu pompayi kendi donanim seviyesinde
// guvenli konuma alir. Su an noop surucude etkisizdir, ama araligin gercek bir kutunun
// bekleyecegi kadar sik olmasi onemli oldugundan simdiden guvenlik sensoruyle ayni cari kullanilir.
const automationAliveInterval = setInterval(sendAutomationAliveSignals, 10 * 1000);
automationAliveInterval.unref();

// Dayanikli yazma kuyrugu (bkz. writeQueueService.ts) - Kafka/RabbitMQ'nun bu
// uygulamadaki islevsel karsiligi. Su an tek tuketicisi kritik alarm bildirimleri
// (e-posta/SMS) - hizli calismasi (2sn) bildirimlerin gecikmesiz gitmesini saglar.
processWriteQueue().catch((err) => logger.error({ err }, "Yazma kuyrugu islenemedi."));
const writeQueueInterval = setInterval(() => {
  processWriteQueue().catch((err) => logger.error({ err }, "Yazma kuyrugu islenemedi."));
}, 2 * 1000);
writeQueueInterval.unref();

// Islenmis kuyruk kayitlarinin gunluk temizligi - tablo sonsuza dek buyumesin.
const writeQueuePruneInterval = setInterval(() => pruneWriteQueue(), 24 * 60 * 60 * 1000);
writeQueuePruneInterval.unref();

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
