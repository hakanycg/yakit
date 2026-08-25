/**
 * Is gunu siniri - TEK KAYNAK.
 *
 * Islem zaman damgalari UTC'dir. UTC tarihine gore gruplamak gunu yerel saatle 03:00'te
 * bolerdi: gece 01:30'daki bir satis bir onceki gune yazilir ve kasayi kapatan kisi
 * ekstresiyle tutmayan bir rakam gorurdu (bkz. reconciliationService.ts).
 *
 * Turkiye 2016'dan beri yil boyu UTC+3'tur (yaz saati uygulamasi yok), bu yuzden sabit
 * ofset dogru sonuc verir.
 *
 * Burada tek yerde durmasinin sebebi: mutabakat ile konsolide rapor ayni "bugun"u
 * kastetmeli. Iki ayri sabit tutulsaydi biri degistiginde iki ekran sessizce farkli
 * rakamlar gostermeye baslardi.
 */

/** SQLite date() fonksiyonuna verilecek kaydirma. */
export const BUSINESS_DAY_SQL_OFFSET = "+3 hours";

const OFFSET_MS = 3 * 60 * 60 * 1000;

/** Bir islemin hangi is gunune ait sayilacagi: para, islem tamamlandiginda hareket eder. */
export const BUSINESS_DAY_ANCHOR = "COALESCE(completed_at, created_at)";

/**
 * JOIN'li sorgularda kolon adlarinin basina tablo takma adi gerekir. Bunu cagiran
 * tarafta string degistirerek yapmak kirilgandir (kolon adi degisince sessizce bozulur),
 * bu yuzden takma ad burada uretilir.
 */
export function businessDayExpr(alias?: string): string {
  const p = alias ? `${alias}.` : "";
  return `date(COALESCE(${p}completed_at, ${p}created_at), '${BUSINESS_DAY_SQL_OFFSET}')`;
}

export function currentBusinessDate(now = new Date()): string {
  return new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** N gun onceki is gunu; rapor varsayilan araliklari icin. */
export function businessDateDaysAgo(days: number, now = new Date()): string {
  return currentBusinessDate(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
}
