import { logger } from "./logger.js";

/**
 * Fiziksel bir ÖKC (Odeme Kaydedici Cihaz / yasal yazar kasa) ile konusan katmanin
 * soyutlamasi. PrinterDriver ile AYNI desen: su an tek uygulama var (noopOkcDriver,
 * hep basarisiz doner) - "istasyonda gercek bir ÖKC var mi, yoksa mevcut Uyumsoft
 * e-fatura/e-arsiv entegrasyonu (bkz. transactionService.ts) yasal olarak yeterli mi"
 * sorusu henuz teyit edilmedi (bkz. gorev #101). Teyit edilip gercek bir ÖKC gerekirse,
 * bu arayuzu uygulayan yeni bir surucu yazip setOkcDriver() ile devreye alinir - kiosk/
 * server tarafinda baska hicbir degisiklik gerekmez.
 */
export interface FiscalReceiptLine {
  label: string;
  value: string;
}

export interface FiscalReceiptJob {
  title: string;
  lines: FiscalReceiptLine[];
  transactionId: number;
  amount: number;
}

export type OkcFaultCode = "PAPER_OUT" | "OFFLINE" | "JAMMED" | "UNKNOWN";

export interface OkcPrintResult {
  printed: boolean;
  /** Gercek bir ÖKC basariyla bastiginda dondurdugu yasal fis/mali numara (Z raporu ve denetim icin gerekir). */
  fiscalNo?: string;
  /** Yalnizca GERCEK bir ÖKC fiziksel olarak basarisiz olduysa doldurulur (bkz. printerDriver.ts'teki ayni mantik). */
  faultCode?: OkcFaultCode;
}

export interface OkcDriver {
  printFiscalReceipt(job: FiscalReceiptJob): Promise<OkcPrintResult>;
}

export const noopOkcDriver: OkcDriver = {
  async printFiscalReceipt(job) {
    logger.info(
      { transactionId: job.transactionId, amount: job.amount },
      "Yasal fis (ÖKC) istegi alindi - henuz fiziksel bir ÖKC baglanmadi, sadece loglaniyor (fiziksel/yasal cikti yok)."
    );
    return { printed: false };
  },
};

let activeDriver: OkcDriver = noopOkcDriver;

export function getOkcDriver(): OkcDriver {
  return activeDriver;
}

/** Gercek bir ÖKC baglanip yasal gereklilik netlesince, bu fonksiyonla noop surucunun yerine gercek surucu takilir. */
export function setOkcDriver(driver: OkcDriver): void {
  activeDriver = driver;
}
