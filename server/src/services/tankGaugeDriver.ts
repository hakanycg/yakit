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
 * baglaninca bu arayuzu uygulayan bir surucu yazilip setTankGaugeDriver() ile devreye
 * alinir; periyodik okuma dongusune (bkz. tankGaugeService.ts) dokunmaya gerek kalmaz.
 *
 * Marka farkliliklari surucunun icinde kalir: cogu prob seri port (RS-232/485) veya
 * TCP uzerinden konusur ve her birinin kendi protokolu vardir, ama disariya verdikleri
 * sey aynidir - o andaki hacim.
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

let activeDriver: TankGaugeDriver = noopTankGaugeDriver;

export function getTankGaugeDriver(): TankGaugeDriver {
  return activeDriver;
}

/** Gercek prob baglandiginda, sunucu baslangicinda noop surucusunun yerine gercek surucu takilir. */
export function setTankGaugeDriver(driver: TankGaugeDriver): void {
  activeDriver = driver;
}
