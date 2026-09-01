/**
 * Plaka karsilastirma/arama icin TEK dogru normal form.
 *
 * Farkli girdi kaynaklari (kiosk'ta elle yazma, admin panelinde elle ekleme, simule LPR)
 * plakayi FARKLI bosluklarla uretebiliyordu ("06VY894" vs "06 VY 894"). Eskiden
 * kullanilan "ardisik bosluklari tek bosluga indir" normallestirmesi (`replace(/\s+/g," ")`)
 * bunu COZMEZ: "hic bosluk yok" ile "zaten tek bosluk var" farkli string'ler olarak kalir,
 * hicbir zaman esitlenmez. Bu yuzden filo hesabi eslesmesi, sadakat puani, yanlis yakit
 * kontrolu, KVKK sorgusu gibi TUM plaka bazli ozellikler sessizce eslesme kacirabiliyordu.
 *
 * Dogru cozum TUM boslugu kaldirmak: plaka formatinda bosluk hicbir zaman anlam tasimaz,
 * yalnizca okunabilirlik icindir (ekranda gosterirken ayri bir bicimlendirme fonksiyonu
 * kullanilabilir, ama KARSILASTIRMA/SAKLAMA her zaman bu fonksiyondan gecmelidir).
 */
export function normalizePlate(plate: string): string {
  return plate.toUpperCase().replace(/\s+/g, "").trim();
}
