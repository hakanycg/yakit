import { db } from "../db/index.js";
import { logger } from "../utils/logger.js";

/**
 * Fiziksel pompa donanimiyla konusan katmanin soyutlamasi. Su an tek bir uygulamasi var
 * (simulatedDispenserDriver) - gercek donanim yok, dolum tamamen yazilimsal olarak taklit
 * ediliyor. Ileride gercek bir pompa/forecourt entegrasyonu (ör. IFSF veya uretici-ozel bir
 * protokol uzerinden) yapildiginda, bu arayuzu uygulayan yeni bir surucu yazip
 * setDispenserDriver()/setDispenserDriverFor() ile devreye alinabilir - transactionService.ts'in
 * dolum dongusune dokunmaya gerek kalmaz.
 *
 * Not: gercek yakit sayaclari cogu ulkede (Turkiye dahil) metroloji/kalibrasyon
 * sertifikasyonu gerektirir - bu, yazilimla asilamayacak yasal bir zorunluluktur; gercek bir
 * surucu yazmadan once bunu saglayan sertifikali bir pompa/kontrolor gerekir.
 *
 * COKLU CIHAZ DESTEGI: eskiden tek bir global surucu vardi - ayni istasyonda farkli
 * marka/protokol (ör. RS485/Modbus RTU bir ada, TCP/IFSF baska bir ada) pompa AYNI ANDA
 * desteklenemiyordu (bkz. tankGaugeDriver.ts'teki AYNI sorun ve cozum). Asagidaki kayit
 * defteri (pumpId -> surucu) bunu cozer; `setDispenserDriver()` hala global bir VARSAYILAN
 * atar (geriye donuk uyumluluk ve tek marka kullanan istasyonlar icin), `setDispenserDriverFor()`
 * ise belirli bir pompa icin varsayilani gecersiz kilar.
 */

export interface DispenserTickResult {
  /** Bu tick'te akan (heniz depo/tank kisitina karsi sinirlanmamis) litre miktari. */
  liters: number;
  /**
   * true ise dolum bu tick'te sona erer - hedef litreye ulasilmamis olsa bile. Gercek
   * donanimda bu, tabancanin fiziksel olarak (otomatik klik-off ile veya musteri elle)
   * yerine takildigi anlamina gelir. Simulasyonda hic tetiklenmez (false).
   */
  nozzleStopped: boolean;
}

export interface DispenserDriver {
  /**
   * "Depoyu Doldur" (full_tank) modunda dolumun ne kadar surecegini belirler. Simulasyonda
   * gercekci bir binek arac deposu araligindan (28-55L) rastgele bir hedef secilir. Gercek
   * donanimda byle bir hedef ONCEDEN bilinemez - tabanca ne zaman klik-off yapacagini
   * yalnizca fiziksel olarak gerceklestiginde belli eder - bu yuzden gercek bir surucu burada
   * `null` donmelidir; bu durumda dolum yalnizca tick()'in nozzleStopped=true dondurdugu
   * anda biter (bkz. DispenserTickResult).
   */
  pickFullTankTargetLiters(): number | null;

  /** Bir dolum tick'inde (yaklasik `elapsedMs` sure icinde) ne kadar litre aktigini dondurur. */
  tick(elapsedMs: number): DispenserTickResult;

  /**
   * "Depoyu Doldur" islemi baslamadan once (odeme yetkilendirmesi icin) gosterilecek/rezerve
   * edilecek olasi EN YUKSEK litre tahmini. pickFullTankTargetLiters()'in aksine rastgele
   * degildir - sabit, kotu-senaryo bir ust sinirdir (ödeme aginin bir tutar tutmasi/blokaj
   * koymasi icin gercek dolum bitmeden bir rakama ihtiyaci vardir).
   */
  estimateMaxFullTankLiters(): number;
}

const FLOW_LITERS_PER_SEC_MIN = 0.45;
const FLOW_LITERS_PER_SEC_MAX = 0.75;
const FULL_TANK_MIN_LITERS = 28;
const FULL_TANK_MAX_LITERS = 55;

export const simulatedDispenserDriver: DispenserDriver = {
  pickFullTankTargetLiters(): number {
    return FULL_TANK_MIN_LITERS + Math.random() * (FULL_TANK_MAX_LITERS - FULL_TANK_MIN_LITERS);
  },
  tick(elapsedMs: number): DispenserTickResult {
    const flowRate = FLOW_LITERS_PER_SEC_MIN + Math.random() * (FLOW_LITERS_PER_SEC_MAX - FLOW_LITERS_PER_SEC_MIN);
    return { liters: flowRate * (elapsedMs / 1000), nozzleStopped: false };
  },
  estimateMaxFullTankLiters(): number {
    return FULL_TANK_MAX_LITERS;
  },
};

let defaultDriver: DispenserDriver = simulatedDispenserDriver;
const driversByPumpId = new Map<number, DispenserDriver>();

/** @deprecated Cogu kurulumda hala gecerli tek isim - tum pompalar icin VARSAYILAN surucuyu doner. Belirli bir pompaya ozel marka icin getDispenserDriverFor() kullanin. */
export function getDispenserDriver(): DispenserDriver {
  return defaultDriver;
}

/** Gercek donanim entegrasyonu yapildiginda, sunucu baslangicinda bu fonksiyonla simulasyon surucusunun yerine VARSAYILAN surucu takilir - o pompaya ozel bir surucu tanimlanmamis her pompa icin kullanilir. */
export function setDispenserDriver(driver: DispenserDriver): void {
  defaultDriver = driver;
}

/** Belirli bir pompa icin ozel bir surucu tanimlar - ayni istasyondaki farkli adalar/pompalar farkli marka/protokolle ayni anda calisabilir. */
export function setDispenserDriverFor(pumpId: number, driver: DispenserDriver): void {
  driversByPumpId.set(pumpId, driver);
}

/** Bu pompa icin tanimli ozel bir surucu varsa onu, yoksa VARSAYILAN surucuyu doner. */
export function getDispenserDriverFor(pumpId: number): DispenserDriver {
  return driversByPumpId.get(pumpId) ?? defaultDriver;
}

/** Testler arasi izolasyon icin: tum pompaya-ozel kayitlari temizler (VARSAYILANI etkilemez). */
export function clearDispenserDriverRegistry(): void {
  driversByPumpId.clear();
}

/** Bu pompaya ozel kaydi kaldirir - pompa tekrar global VARSAYILAN surucuyu kullanir (ör. protokol yapilandirmasi kaldirildiginda). */
export function clearDispenserDriverFor(pumpId: number): void {
  driversByPumpId.delete(pumpId);
}

interface ProtocolConfigRow {
  id: number;
  protocol_type: string;
}

/**
 * Sunucu baslangicinda, protokolu yapilandirilmis her pompa icin gercek bir surucu
 * varsa kaydeder. Bu ortamda hicbir gercek protokol (RS485/Modbus RTU, TCP/IFSF,
 * pulse, 4-20mA vb.) uygulanmiyor - saha isi, gercek donanim/metroloji sertifikasyonu
 * olmadan yazilamaz/dogrulanamaz (bkz. dosya basindaki yorum). Ama kayit NOKTASI
 * burasi: gercek bir surucu yazilinca tek yapilacak sey asagidaki switch'e bir case
 * eklemek, cagiran kod (transactionService.ts) hic degismez.
 *
 * Yapilandirilmis ama karsiligi olmayan protokoller icin uyari loglanir - "protokol
 * secildi ama hicbir sey olmuyor" sessizce gecmez. Simulasyon surucusune dusmek
 * (tank probunun aksine noop degil) bilerek boyle: bir pompadan dolum HER ZAMAN bir
 * seyler akitmali, "hic okuma yok" pompa icin anlamli bir durum degildir.
 */
export function loadConfiguredDispenserDrivers(): void {
  const rows = db.prepare<[], ProtocolConfigRow>("SELECT id, protocol_type FROM pumps WHERE protocol_type IS NOT NULL").all();
  for (const row of rows) {
    // Henuz hicbir protokol icin gercek surucu yok - hepsi bu uyariya dusuyor.
    logger.warn(
      { pumpId: row.id, protocolType: row.protocol_type },
      "Pompa iletisim protokolu yapilandirilmis ama bu protokol icin gercek surucu henuz yok - varsayilan (simulasyon) surucu kullanilacak."
    );
    setDispenserDriverFor(row.id, simulatedDispenserDriver);
  }
}
