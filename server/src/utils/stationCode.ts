import { randomInt } from "node:crypto";

/**
 * Istasyonlara "STM1234" bicimindeki kisa, benzersiz kod - kiosk adresinde
 * (/kiosk/STM1234) ve destek/envanter kayitlarinda kullanilir.
 *
 * DIKKAT: Bu kod bir SIR DEGILDIR, bir GUVENLIK onlemi olarak gorulmemelidir
 * (4 hane = 10.000 ihtimal; tahmin edilebilir). Kiosk'un gercek kimlik dogrulamasi
 * station_kiosks.device_token ile yapilir (bkz. kioskDevice.ts). Bu kod yalnizca
 * okunabilir/benzersiz bir tanimlayicidir: istasyon adi degisse bile adres sabit
 * kalir ve URL'de isletme adi gorunmez.
 */
const PREFIX = "STM";

export function generateStationCode(isTaken: (code: string) => boolean): string {
  // Once 4 haneli (okunmasi/soylenmesi kolay) dene; cakisma birikirse hane sayisini
  // artirarak alani genislet - boylece istasyon sayisi buyudugunde de tikanmaz.
  for (const digits of [4, 5, 6]) {
    const max = 10 ** digits;
    for (let attempt = 0; attempt < 200; attempt++) {
      const code = `${PREFIX}${String(randomInt(0, max)).padStart(digits, "0")}`;
      if (!isTaken(code)) return code;
    }
  }
  throw new Error("Benzersiz istasyon kodu uretilemedi.");
}

/** Kullanicidan/URL'den gelen kodu normalize eder: "stm 1234" -> "STM1234". */
export function normalizeStationCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}
