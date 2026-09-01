/**
 * UTTS (Ulusal Tasit Tanima Sistemi) - 31 Ocak 2025'ten beri zorunlu, GIB'in resmi sistemi.
 * Araca takilan TTB (Tasit Tanima Birimi), pompa tabancasindaki TTO okuyucusuyla okunur;
 * TIM (Tabanca Iletisim Modulu) bu plakayi YN Pompa OKC'ye (bkz. #101/#102 - ayni
 * sertifikali fiskal pompa cihazi) aktarip GIB'e bildirir.
 *
 * TTB/TTO gercek, sertifikali donanimdir - bu arayuzu biz UYGULAYAMAYIZ, yalnizca
 * sisteme baglanacagi bir yer hazirlariz. SafetySensorDriver/DispenserDriver/
 * TankGaugeDriver ile ayni desen: su an tek uygulama var (noopVehicleIdentificationDriver,
 * hep null doner - "okuyucu bagli degil"). Gercek TTO baglaninca bu arayuzu uygulayan bir
 * surucu yazilip setVehicleIdentificationDriver() ile devreye alinir.
 *
 * ONEMLI SINIR: UTTS bize "bu aracin motoru hangi yakiti kullanir" bilgisini VERMEZ -
 * yalnizca plakayi otomatik ve guvenilir sekilde tespit eder. Katkisi, mevcut yanlis yakit
 * kontrolunun (getLastFuelTypeForPlate / filo expected_fuel_type) EN ZAYIF halkasini
 * (musterinin kiosk'ta plakayi yanlis/eksik yazmasi) ortadan kaldirmasidir - kontrolun
 * kendisi degismez, girdisi guvenilir hale gelir.
 */

export interface VehicleIdentificationReading {
  /** TTO'nun o an tabancada okudugu plaka. */
  plate: string;
}

export interface VehicleIdentificationDriver {
  /**
   * Bu pompada bir TTO okuyucusu bagliysa ve tabanca depoya sokulduysa okunan plakayi
   * doner. Okuyucu yoksa/henuz okuma olmadiysa null doner - null, "plaka yok" degil
   * "bu kaynaktan bilgi yok" anlamina gelir; cagiran taraf musteriye elle giris
   * sormaya devam eder.
   */
  read(stationId: number, pumpId: number): VehicleIdentificationReading | null;
}

export const noopVehicleIdentificationDriver: VehicleIdentificationDriver = {
  read: () => null,
};

let activeDriver: VehicleIdentificationDriver = noopVehicleIdentificationDriver;

export function getVehicleIdentificationDriver(): VehicleIdentificationDriver {
  return activeDriver;
}

/** Gercek TTO okuyucusu baglandiginda, sunucu baslangicinda noop surucusunun yerine gercek surucu takilir. */
export function setVehicleIdentificationDriver(driver: VehicleIdentificationDriver): void {
  activeDriver = driver;
}
