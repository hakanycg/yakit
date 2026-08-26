import { describe, expect, it } from "vitest";
import { csvEscape } from "./csv.js";

/**
 * CSV disa aktarimlarindaki alanlarin bir kismini DISARIDAN gelen kisiler yaziyor:
 * filo musterisi bakiye yukleme talebine not dusuyor, kiosk'ta plaka giriliyor,
 * baska bir kiraci yoneticisi istasyon adi/kiosk etiketi giriyor. Excel bu alanlari
 * `=`/`+`/`-`/`@` ile basliyorsa FORMUL sayar.
 */
describe("csvEscape", () => {
  it("formulle baslayan metni tirnaklayarak etkisiz kilar", () => {
    for (const evil of [
      '=HYPERLINK("http://saldirgan.example","Tikla")',
      "+1+1",
      "@SUM(A1:A9)",
      "\tgizli",
      "\rgizli",
    ]) {
      // Deger ayrica alan kacisi gerektiriyorsa tirnak icine alinir; her iki durumda
      // da tek tirnak, formul tetikleyicisinin HEMEN onunde olmalidir.
      expect(csvEscape(evil)).toMatch(/^(?:'|"')/);
    }
  });

  it("sayilari BOZMAZ - negatif tutar sayi olarak kalir", () => {
    // Sadece "-" ile basliyor diye tirnaklansaydi, mutabakat raporundaki iade/
    // duzeltme sutunlari Excel'de toplanamaz hale gelirdi.
    expect(csvEscape(-125.4)).toBe("-125.4");
    expect(csvEscape("-125.40")).toBe("-125.40");
    expect(csvEscape("+3")).toBe("+3");
    expect(csvEscape(0)).toBe("0");
  });

  it("CSV alan kacisini korur", () => {
    expect(csvEscape('Ali "Usta" Ltd.')).toBe('"Ali ""Usta"" Ltd."');
    expect(csvEscape("Ankara, Cankaya")).toBe('"Ankara, Cankaya"');
    expect(csvEscape("bir\niki")).toBe('"bir\niki"');
  });

  it("bos degerleri bos sutun yapar", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape("")).toBe("");
  });

  it("formul kacisi ile alan kacisi birlikte calisir", () => {
    // Hem formulle basliyor hem virgul iceriyor: once tek tirnak eklenir, sonra alan
    // tirnaklanir - ikisi birbirini bozmamali.
    expect(csvEscape('=A1,B1')).toBe('"\'=A1,B1"');
  });
});
