import { describe, expect, it } from "vitest";
import { MESSAGE_ALPHABET, keyboardRows, type KeyboardLayout } from "./KioskKeyboard";
import type { KioskLang } from "./i18n";

const LANGS: KioskLang[] = ["tr", "en", "ru", "de", "ar"];

function keysOf(layout: KeyboardLayout, lang: KioskLang): string[] {
  return keyboardRows(layout, lang).flat();
}

describe("kiosk klavye tus takimi", () => {
  it("sayisal takimda harf yoktur", () => {
    const keys = keysOf("numeric", "tr");
    expect(keys).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
  });

  it("ondalik takimda virgul vardir, sayisal takimda yoktur", () => {
    expect(keysOf("decimal", "tr")).toContain(",");
    expect(keysOf("numeric", "tr")).not.toContain(",");
  });

  it("plaka tuslari HER DILDE Latin kalir", () => {
    // Plaka bir kimliktir: Arapca arayuzde Arap harfli tus takimi vermek, plakanin
    // yanlis yazilmasina yol acardi.
    for (const lang of LANGS) {
      const keys = keysOf("plate", lang);
      expect(keys).toContain("A");
      expect(keys).toContain("Z");
      expect(keys).toContain("0");
      expect(keys.join("")).toMatch(/^[A-Z0-9]+$/);
    }
  });

  it("kampanya kodu ve e-posta da her dilde Latin kalir", () => {
    for (const lang of LANGS) {
      expect(keysOf("code", lang).join("")).toMatch(/^[A-Z0-9]+$/);
      expect(keysOf("email", lang)).toContain("@");
      expect(keysOf("email", lang)).toContain(".");
    }
  });

  it("serbest metin takimi musterinin kendi alfabesini gosterir", () => {
    expect(keysOf("message", "ru")).toContain("Ж");
    expect(keysOf("message", "tr")).toContain("Ğ");
    expect(keysOf("message", "de")).toContain("ß");
    expect(keysOf("message", "ar")).toContain("ش");
    // Rusca yazan musteriye Latin takim vermek o alani kullanilamaz hale getirirdi.
    expect(keysOf("message", "ru")).not.toContain("W");
  });

  it("her dilin serbest metin alfabesi dolu ve makul uzunluktadir", () => {
    // Yeni bir dil eklenip alfabesi unutulursa klavye bos cikardi.
    for (const lang of LANGS) {
      expect(MESSAGE_ALPHABET[lang].length).toBeGreaterThan(20);
    }
  });

  it("hicbir satir asiri uzun degildir - tus takimi ekrana sigmali", () => {
    for (const lang of LANGS) {
      for (const layout of ["numeric", "decimal", "plate", "code", "email", "message"] as KeyboardLayout[]) {
        for (const row of keyboardRows(layout, lang)) {
          expect(row.length).toBeLessThanOrEqual(10);
        }
      }
    }
  });
});
