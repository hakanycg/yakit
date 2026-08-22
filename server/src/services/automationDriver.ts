import { db } from "../db/index.js";
import type { StationRow } from "../db/types.js";
import { logger } from "../utils/logger.js";

/**
 * EPDK 1240 sayili Kurul Karari geregi zorunlu Istasyon Otomasyon Sistemi (IOS) ile
 * konusan katmanin soyutlamasi (bkz. gorev #87). Su an tek uygulamasi var
 * (noopAutomationDriver) - hangi dagitim sirketinin hangi EPDK-onayli otomasyon
 * kutusunu (Turpak/Bimsa/ELPO/Petrotek vb.) kullandigi netlesmeden gercek bir
 * entegrasyon yazilamaz. DispenserDriver/SafetySensorDriver/PrinterDriver ile AYNI
 * desen: arayuz + noop varsayilan simdiden hazir, gercek IOS protokolu netlesince
 * setAutomationDriver() ile TEK YERDEN devreye alinir - transactionService.ts'in
 * dolum akisina veya index.ts'in periyodik dongulerine dokunmaya gerek kalmaz.
 */
export interface AutomationSaleReport {
  transactionId: number;
  stationId: number;
  pumpId: number;
  plate: string;
  fuelType: string;
  liters: number;
  amount: number;
  pricePerLiter: number;
  completedAt: string;
}

export interface AutomationDriver {
  /**
   * Dolum "authorized" durumundan "dispensing"e gectiginde cagrilir (5 adimli akisin
   * "otomasyon tetikleme" adimi). Gercek IOS'ta bu, pompanin fiilen acilmasi icin
   * otomasyon kutusuna verilen komuttur; simdilik yalnizca DispenserDriver simulasyonu
   * kendi basina "dolum baslat" karari veriyor, IOS bunu sadece BILGILENDIRME amacli izler.
   */
  reportDispenseStart(stationId: number, pumpId: number, transactionId: number): void;

  /**
   * Dolum tamamlanip kesin satis verisi (litre/tutar) belli olunca cagrilir - IOS'un
   * EPDK'ya yarim saatte bir raporlama yukumlulugunu bizim tarafimizdan beslemesi icin.
   */
  reportSaleCompleted(report: AutomationSaleReport): void;

  /**
   * Failsafe/dead-man's-switch (bkz. gorev #87 notu): gercek bir IOS kutusu tipik
   * olarak bu turden periyodik bir "canliyim" sinyali BEKLER - sinyal kesilirse
   * (yazilim coktu/baglanti koptu) pompayi KENDI DONANIM SEVIYESINDE guvenli konuma
   * alir. noop surucu hicbir sey yapmaz (bekleyen gercek bir kutu yok); gercek IOS
   * baglaninca bu cagri, kutunun beklendigi protokole (ör. belirli araliklarla bir
   * TCP/seri port sinyali) gore doldurulur - boylece yazilimimiz coksa BILE pompa
   * güvenli kalir, cunku failsafe bizim kodumuza degil IOS donanimina dayanir.
   */
  sendAliveSignal(stationId: number): void;
}

export const noopAutomationDriver: AutomationDriver = {
  reportDispenseStart(stationId, pumpId, transactionId) {
    logger.info({ stationId, pumpId, transactionId }, "IOS/otomasyon entegrasyonu henuz yok - dolum baslangici sadece loglandi.");
  },
  reportSaleCompleted(report) {
    // Not: sadece diagnostik icin gerekli alanlar loglanir - plaka gibi kisisel veri
    // pino'nun (potansiyel olarak diske/3. parti log servisine giden) LOG cikisina
    // KASITLI olarak dahil edilmez (bkz. maskPii.ts yorumu). Gercek IOS surucusune
    // iletilen `report` nesnesinin kendisi etkilenmez, yalnizca bu log satiri.
    logger.info(
      { transactionId: report.transactionId, stationId: report.stationId, pumpId: report.pumpId, liters: report.liters, amount: report.amount },
      "IOS/otomasyon entegrasyonu henuz yok - satis verisi sadece loglandi."
    );
  },
  sendAliveSignal() {
    // Bekleyen gercek bir IOS kutusu olmadigindan yapilacak bir sey yok.
  },
};

let activeDriver: AutomationDriver = noopAutomationDriver;

export function getAutomationDriver(): AutomationDriver {
  return activeDriver;
}

/** Gercek IOS entegrasyonu netlesip yazildiginda, sunucu baslangicinda bu fonksiyonla noop surucunun yerine gercek surucu takilir. */
export function setAutomationDriver(driver: AutomationDriver): void {
  activeDriver = driver;
}

/**
 * Periyodik olarak (bkz. index.ts) her aktif istasyon icin sendAliveSignal() cagirir.
 * checkSafetySensors ile ayni cari - failsafe/dead-man's-switch niteligindeki bu sinyalin,
 * gercek bir IOS baglaninca beklendigi kadar sik gonderilmesi onemlidir; su an noop
 * surucude hicbir etkisi yoktur.
 */
export function sendAutomationAliveSignals(): void {
  const driver = getAutomationDriver();
  const stations = db.prepare<[], StationRow>("SELECT * FROM stations WHERE active = 1").all();
  for (const station of stations) {
    try {
      driver.sendAliveSignal(station.id);
    } catch (err) {
      logger.error({ err, stationId: station.id }, "IOS 'canliyim' sinyali gonderilemedi.");
    }
  }
}
