/**
 * Istasyonun ZATEN KURULU yangin/gaz alarm sistemiyle (itfaiye ruhsati/TS 12820 geregi
 * her istasyonda zaten bulunan bir yangin alarm santrali) konusan katmanin soyutlamasi.
 *
 * Karar (bkz. gorev #89/#90): yeni sensor satin alinmiyor - mevcut panelin GENEL ALARM
 * ROLESI (kuru kontak NO/NC) cikisi okunacak. Bu sinyal markadan bagimsizdir (devre
 * kapanir/acilir, hepsi ayni davranir) - sadece fiziksel kablolama (terminal numaralari)
 * panele ozeldir ve gercek istasyon kurulup panel netlesince belirlenecektir.
 *
 * DispenserDriver ile ayni desen: su an tek uygulama var (noopSafetySensorDriver, hep
 * "alarm yok" doner) - gercek donanim (dijital giris modulu) baglaninca bu arayuzu
 * uygulayan yeni bir surucu yazip setSafetySensorDriver() ile devreye alinabilir;
 * checkSafetySensors()'un (bkz. safetyMonitorService.ts) periyodik kontrol dongusune
 * dokunmaya gerek kalmaz.
 */
export interface SafetySensorDriver {
  /**
   * Istasyonun yangin/gaz alarm panelinden su an aktif bir alarm sinyali geliyor mu?
   * Varsa acil durdurma sebebi olarak kullanilacak insan-okunur bir mesaj, yoksa null doner.
   */
  checkAlarm(stationId: number): string | null;
}

export const noopSafetySensorDriver: SafetySensorDriver = {
  checkAlarm: () => null,
};

let activeDriver: SafetySensorDriver = noopSafetySensorDriver;

export function getSafetySensorDriver(): SafetySensorDriver {
  return activeDriver;
}

/** Gercek donanim entegrasyonu yapildiginda, sunucu baslangicinda bu fonksiyonla noop surucusunun yerine gercek surucu takilir. */
export function setSafetySensorDriver(driver: SafetySensorDriver): void {
  activeDriver = driver;
}
