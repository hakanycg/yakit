import { logger } from "./logger.js";

/**
 * Kiosk'a gomulu/entegre temassiz odeme (POS) donanimiyla konusan katmanin
 * soyutlamasi. okcDriver.ts/printerDriver.ts ile AYNI desen: su an tek uygulama
 * var (noopPosDriver, hep NOT_CONNECTED doner) - hangi vendor'in hangi EMV/PCI
 * sertifikali modulun secildigi ve o modulun onay/red sinyalini nasil ilettigi
 * henuz netlesmedi (bkz. gorev #141).
 *
 * KAPSAM BILEREK SINIRLI: bu dosya yalnizca donanim gelmeden ONCE, vendor
 * cevabindan BAGIMSIZ olarak kurulabilecek soyutlamayi saglar. Kiosk'un merkez
 * sunucuya "POS ile tahsil edildi" diyecegi GERCEK uc (ör. bir /pos/charge HTTP
 * ucu) bilerek burada YOK - hangi vendor'in hangi protokolu konustugu
 * netlesmeden bir onay/guvenlik modeli TAHMIN EDEREK yazilmayacak (iyzico'nun
 * imza sirasinin resmi dokumantasyon olmadan asla uydurulmamis olmasiyla ayni
 * gerekce). Vendor cevabi geldiginde: (1) bu arayuzu uygulayan gercek bir
 * surucu yazilir, (2) setPosDriver() ile devreye alinir, (3) kiosk'un merkez
 * sunucuya sonucu bildirecegi uc o zaman, o protokole gore tasarlanir.
 */
export interface PosChargeJob {
  transactionId: number;
  /** Tahsil edilecek tutar (TL). */
  amount: number;
}

/**
 * Gercek bir POS surucusunun tahsilat sirasinda tespit edebilecegi somut ariza
 * turleri. noop surucu (henuz donanim yok) BUNLARDAN HICBIRINI dondurmez -
 * "donanim yok" beklenen/normal bir durumdur, ariza degildir; faultCode yalnizca
 * GERCEK bir surucunun fiziksel/agsal olarak basarisiz oldugu durumlar icindir
 * (bkz. okcDriver.ts/printerDriver.ts'teki ayni ayrim - server.ts bu alani
 * gordugunde merkez sunucuya kritik bir alarm bildirir, o yuzden noop'un her
 * cagrida bunu doldurmasi YANLIS olur: her tahsilat denemesinde sahte bir
 * "POS arizali" alarmi dogurur).
 */
export type PosFaultCode = "DECLINED" | "TIMEOUT" | "OFFLINE" | "UNKNOWN";

export interface PosChargeResult {
  /** true donerse tahsilat GERCEKTEN yapilmistir. false/noop ise para tahsil EDILMEMISTIR. */
  success: boolean;
  /** Yalnizca GERCEK bir POS basarili tahsilat yaptiginda doldurulur (mutabakat/iade icin izlenebilirlik). */
  referenceId?: string;
  /** Yalnizca GERCEK bir POS fiziksel/agsal olarak basarisiz olduysa doldurulur (bkz. yukarida). */
  faultCode?: PosFaultCode;
  message: string;
}

export interface PosDriver {
  chargeContactless(job: PosChargeJob): Promise<PosChargeResult>;
}

export const noopPosDriver: PosDriver = {
  async chargeContactless(job) {
    logger.info(
      { transactionId: job.transactionId, amount: job.amount },
      "Temassiz POS tahsilat istegi alindi - henuz fiziksel bir POS modulu baglanmadi, sadece loglaniyor (tahsilat YAPILMADI)."
    );
    return { success: false, message: "POS donanimi henuz baglanmadi." };
  },
};

let activeDriver: PosDriver = noopPosDriver;

export function getPosDriver(): PosDriver {
  return activeDriver;
}

/** Gercek bir POS modulu baglanip vendor protokolu netlesince, bu fonksiyonla noop surucunun yerine gercek surucu takilir. */
export function setPosDriver(driver: PosDriver): void {
  activeDriver = driver;
}
