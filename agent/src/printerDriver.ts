import { logger } from "./logger.js";

/**
 * Kiosk'ta fis yazdirma su ana kadar sadece tarayicinin kendi window.print()'ine
 * (kiosk PC'de OS seviyesinde varsayilan yazici olarak ayarlanmis bir termal yazici +
 * Chromium "--kiosk-printing" bayragi varsayimiyla) dayaniyordu. Henuz gercek bir
 * fiziksel termal fis yazicisi baglanmadigi icin (bkz. gorev #96/#97 - SafetySensorDriver
 * ile ayni karar: donanim gelene kadar genel bir soyutlama kurulur), bu modul o
 * soyutlamayi ajan tarafinda saglar: kiosk, tamamlanan her islemde ONCE ayni
 * makinedeki ajanin yerel /print ucuna dener, ajan/gercek yazici yoksa (ki su an
 * HER ZAMAN boyle) false doner ve kiosk eskisi gibi window.print()'e duser - yani
 * bugunku davranista HICBIR degisiklik yok, sadece gercek donanim gelince
 * setPrinterDriver() ile tek yerden degistirilebilecek bir kanca eklenmis olur.
 */
export interface ReceiptLine {
  label: string;
  value: string;
}

export interface ReceiptPrintJob {
  title: string;
  lines: ReceiptLine[];
  transactionId: number;
}

/**
 * Gercek bir termal yazici surucusunun print() sirasinda tespit edebilecegi somut ariza
 * turleri. noop surucu (henuz donanim yok) BUNLARDAN HICBIRINI dondurmez - "donanim yok"
 * beklenen/normal bir durumdur, ariza degildir; faultCode yalnizca GERCEK bir surucunun
 * fiziksel olarak basarisiz oldugu durumlar icindir (bkz. server.ts /print rotasi, bu alani
 * gordugunde merkez sunucuya kritik bir alarm bildirir).
 */
export type PrinterFaultCode = "PAPER_OUT" | "OFFLINE" | "JAMMED" | "UNKNOWN";

export interface PrinterPrintResult {
  /**
   * true donerse fis fiziksel olarak yazdirilmistir. false/noop ise hicbir fiziksel
   * cikti YOKTUR - cagiran taraf (kiosk) bunu "basarili yazdirma" gibi sunmamali,
   * alternatif bir yontemle (window.print) musteriye fis saglamaya devam etmelidir.
   */
  printed: boolean;
  /** Yalnizca gercek bir yazici GERCEKTEN basarisiz olduysa doldurulur (bkz. yukarida). */
  faultCode?: PrinterFaultCode;
}

export interface PrinterDriver {
  print(job: ReceiptPrintJob): Promise<PrinterPrintResult>;
}

export const noopPrinterDriver: PrinterDriver = {
  async print(job) {
    logger.info(
      { transactionId: job.transactionId, lineCount: job.lines.length },
      "Fis yazdirma istegi alindi - henuz gercek termal yazici baglanmadi, sadece loglaniyor (fiziksel cikti yok)."
    );
    return { printed: false };
  },
};

let activeDriver: PrinterDriver = noopPrinterDriver;

export function getPrinterDriver(): PrinterDriver {
  return activeDriver;
}

/** Gercek donanim (ESC/POS uzerinden USB/seri/ag) baglandiginda, bu fonksiyonla noop surucunun yerine gercek surucu takilir. */
export function setPrinterDriver(driver: PrinterDriver): void {
  activeDriver = driver;
}
