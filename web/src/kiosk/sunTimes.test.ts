import { describe, expect, it } from "vitest";
import { isDaylight, lightWindow } from "./sunTimes";

/** Turkiye yil boyu UTC+3; ekranin gordugu yerel saati bu ofsetle okuyoruz. */
function trHour(ms: number): number {
  return new Date(ms + 3 * 3_600_000).getUTCHours() + new Date(ms + 3 * 3_600_000).getUTCMinutes() / 60;
}

const ISTANBUL = { lat: 41.0082, lng: 28.9784 };
const ANTALYA = { lat: 36.8969, lng: 30.7133 };
const ERZURUM = { lat: 39.9, lng: 41.27 };

const JUNE = Date.parse("2026-06-21T09:00:00Z");
const DECEMBER = Date.parse("2026-12-21T09:00:00Z");

describe("gun isigi penceresi", () => {
  it("Istanbul'da yaz ve kis birbirinden saatlerce farklidir", () => {
    const summer = lightWindow(JUNE, ISTANBUL.lat, ISTANBUL.lng)!;
    const winter = lightWindow(DECEMBER, ISTANBUL.lat, ISTANBUL.lng)!;

    // Yaz gunu ~21:15'e kadar aydinlik, kis gunu ~18:10'da kararir.
    expect(trHour(summer.end)).toBeGreaterThan(21);
    expect(trHour(winter.end)).toBeLessThan(18.5);
    // Sabit 07:00-19:00 kaliginin tam olarak kacirdigi sey bu: yazin aksam 19:00'da
    // hava aydinlik, kisin 18:30'da karanlik.
    expect(trHour(summer.start)).toBeLessThan(5.5);
    expect(trHour(winter.start)).toBeGreaterThan(7.5);
  });

  it("dogudaki istasyon batidakinden once kararir", () => {
    const erzurum = lightWindow(DECEMBER, ERZURUM.lat, ERZURUM.lng)!;
    const antalya = lightWindow(DECEMBER, ANTALYA.lat, ANTALYA.lng)!;
    // Ayni saat diliminde olsalar da Erzurum'da gunes belirgin sekilde daha erken batar.
    expect(erzurum.end).toBeLessThan(antalya.end);
    expect(trHour(antalya.end) - trHour(erzurum.end)).toBeGreaterThan(0.5);
  });

  it("pencere makul sinirlar icinde ve tutarli siradadir", () => {
    for (const day of [JUNE, DECEMBER]) {
      for (const p of [ISTANBUL, ANTALYA, ERZURUM]) {
        const w = lightWindow(day, p.lat, p.lng)!;
        expect(w.start).toBeLessThan(w.end);
        // Turkiye enlemlerinde gun isigi 8-17 saat arasindadir.
        const hours = (w.end - w.start) / 3_600_000;
        expect(hours).toBeGreaterThan(8);
        expect(hours).toBeLessThan(17);
      }
    }
  });
});

describe("gunduz/gece karari", () => {
  it("ogle vakti gunduz, gece yarisi gecedir", () => {
    expect(isDaylight(Date.parse("2026-06-21T09:00:00Z"), ISTANBUL.lat, ISTANBUL.lng)).toBe(true);
    expect(isDaylight(Date.parse("2026-06-21T21:00:00Z"), ISTANBUL.lat, ISTANBUL.lng)).toBe(false);
  });

  it("kis aksami 18:30'da (yerel) ekran koyu moda gecer - eski sabit saatte gecmiyordu", () => {
    // 2026-12-21 15:30 UTC = Turkiye'de 18:30. Eski kalip 19:00'a kadar acik temadaydi.
    expect(isDaylight(Date.parse("2026-12-21T15:30:00Z"), ISTANBUL.lat, ISTANBUL.lng)).toBe(false);
  });

  it("yaz aksami 19:30'da (yerel) ekran hala acik temadadir", () => {
    // 2026-06-21 16:30 UTC = Turkiye'de 19:30. Eski kalip burada koyuya donuyordu.
    expect(isDaylight(Date.parse("2026-06-21T16:30:00Z"), ISTANBUL.lat, ISTANBUL.lng)).toBe(true);
  });

  it("gun dogumu/batimi tanimsiz olan yerlerde null doner - cagiran taraf yedege duser", () => {
    // Kuzey Kutbu, haziran: gunes hic batmaz.
    expect(isDaylight(JUNE, 89, 0)).toBeNull();
    expect(lightWindow(JUNE, 89, 0)).toBeNull();
  });

  it("konum girilmemis istasyonda hesap yapilmaz", () => {
    expect(isDaylight(JUNE, Number.NaN, ISTANBUL.lng)).toBeNull();
  });
});
