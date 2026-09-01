import type { FuelType } from "../db/types.js";

/**
 * Otomatik tank seviye olcum sistemi (ATG - Automatic Tank Gauging) soyutlamasi.
 *
 * Yakit sapma takibi (bkz. fuelVarianceService.ts) bugun birinin tanka daldirma cubugu
 * sokup sayiyi elle girmesine bagli. Pratikte bu ya seyrek yapilir ya hic, ve sizinti
 * tespiti sessizce calismaz hale gelir. Gercek istasyonlarda tanklarin icinde zaten bir
 * seviye probu bulunur (Veeder-Root TLS, Start Italiana, OPW vb.); bu arayuz o probu
 * sisteme baglamak icindir.
 *
 * SafetySensorDriver/DispenserDriver/PrinterDriver ile ayni desen: su an tek uygulama
 * var (noopTankGaugeDriver, hep null doner - "prob bagli degil"). Gercek donanim
 * baglaninca bu arayuzu uygulayan bir surucu yazilip setTankGaugeDriver()/
 * setTankGaugeDriverFor() ile devreye alinir; periyodik okuma dongusune (bkz.
 * tankGaugeService.ts) dokunmaya gerek kalmaz.
 *
 * Marka farkliliklari surucunun icinde kalir: cogu prob seri port (RS-232/485) veya
 * TCP uzerinden konusur ve her birinin kendi protokolu vardir, ama disariya verdikleri
 * sey aynidir - o andaki hacim.
 *
 * COKLU CIHAZ DESTEGI: eskiden tek bir global surucu vardi - ayni istasyonda farkli
 * markadan birden fazla prob (ör. benzin tanki Veeder-Root, motorin tanki OPW) AYNI ANDA
 * desteklenemiyordu. Asagidaki kayit defteri (station+fuelType -> surucu) bunu cozer;
 * `setTankGaugeDriver()` hala global bir VARSAYILAN atar (geriye donuk uyumluluk ve tek
 * marka kullanan istasyonlar icin), `setTankGaugeDriverFor()` ise belirli bir tank icin
 * varsayilani gecersiz kilar.
 */

export interface TankGaugeReading {
  /** Probun olctugu anlik hacim (litre). */
  liters: number;
  /**
   * Yakit sicakligi (°C), prob destekliyorsa. Sapma hesabinda dogrudan kullanilmaz ama
   * buyuk sicaklik farklari hacim degisimi yaratir ve bir kaybin gercek mi yoksa
   * genlesme mi oldugunu ayirt etmekte insana yardimci olur.
   */
  temperatureCelsius?: number | null;
  /**
   * Tank dibindeki su seviyesi (mm), prob destekliyorsa. ATG problari bunu ayri bir
   * samandirayla olcer. Birim HACIM DEGIL YUKSEKLIKTIR: tabandaki birkac milimetrelik
   * bir katman, tank capina gore cok farkli hacimlere karsilik gelir ve is icin
   * anlamli olan yukseklik (bkz. tankWaterService.ts).
   */
  waterLevelMm?: number | null;
  /** Prob su tarih/saatte okudu. Verilmezse okuma ani kullanilir. */
  measuredAt?: string;
}

export interface TankGaugeDriver {
  /**
   * Istasyonun ilgili tankindaki anlik seviyeyi okur.
   *
   * Prob bagli degilse veya o an okunamiyorsa null doner. Null, "sifir litre" DEGILDIR:
   * cagiran taraf null gordugunde hicbir olcum kaydetmez - okunamayan bir probu bos tank
   * saymak, dogrudan yanlis bir kayip alarmi uretirdi.
   */
  read(stationId: number, fuelType: FuelType): TankGaugeReading | null;
}

export const noopTankGaugeDriver: TankGaugeDriver = {
  read: () => null,
};

let defaultDriver: TankGaugeDriver = noopTankGaugeDriver;
const driversByTank = new Map<string, TankGaugeDriver>();

function tankKey(stationId: number, fuelType: FuelType): string {
  return `${stationId}:${fuelType}`;
}

/** @deprecated Cogu kurulumda hala gecerli tek isim - tum istasyonlar/yakit turleri icin VARSAYILAN surucuyu atar. Belirli bir tanka ozel marka icin setTankGaugeDriverFor() kullanin. */
export function getTankGaugeDriver(): TankGaugeDriver {
  return defaultDriver;
}

/** Gercek prob baglandiginda, sunucu baslangicinda noop surucusunun yerine VARSAYILAN surucu takilir - o tanka ozel bir surucu tanimlanmamis her (istasyon, yakit turu) icin kullanilir. */
export function setTankGaugeDriver(driver: TankGaugeDriver): void {
  defaultDriver = driver;
}

/** Belirli bir istasyon+yakit turu icin (yani tek bir fiziksel tank icin) ozel bir surucu tanimlar - farkli tanklarda farkli marka/protokol probu ayni anda calisabilir. */
export function setTankGaugeDriverFor(stationId: number, fuelType: FuelType, driver: TankGaugeDriver): void {
  driversByTank.set(tankKey(stationId, fuelType), driver);
}

/** Bu tank icin tanimli ozel bir surucu varsa onu, yoksa VARSAYILAN surucuyu doner. */
export function getTankGaugeDriverFor(stationId: number, fuelType: FuelType): TankGaugeDriver {
  return driversByTank.get(tankKey(stationId, fuelType)) ?? defaultDriver;
}

/** Testler arasi izolasyon icin: tum tanka-ozel kayitlari temizler (VARSAYILANI etkilemez). */
export function clearTankGaugeDriverRegistry(): void {
  driversByTank.clear();
}
