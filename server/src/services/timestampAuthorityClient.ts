/**
 * TUBITAK KamuSM (Kamu Sertifikasyon Merkezi) zaman damgasi (RFC 3161) soyutlamasi.
 *
 * archiveService.ts her arsiv dosyasi icin SHA-256 ozeti hesaplayip kaydediyor - bu,
 * dosyanin BOZULMADIGINI ispatlar ("iceriginizi degistirmediniz"). Ama "bu ozet BU
 * TARIHTE var olmustu" iddiasini hukuken kanitlamiyor - onu yalnizca guvenilir bir
 * ucuncu taraf zaman damgasi (KamuSM gibi bir Nitelikli Elektronik Sertifika Hizmet
 * Saglayicisi) verebilir. Bu, denetim kaydi/olcum arsivinin (ADLI/MALI kanit, bkz.
 * archiveService.ts dosya basi yorumu) ispat gucunu artirir.
 *
 * PosDriver/PrinterDriver/TankGaugeDriver ile AYNI desen: KamuSM hesabi henuz acilmadi
 * (ticari/hukuki bir adim, bu depodan yapilamaz) - su an tek uygulama noop
 * (hep null doner, "zaman damgasi alinamadi"). Hesap acilinca bu arayuzu uygulayan
 * gercek bir istemci yazilip setTimestampAuthorityClient() ile devreye alinir;
 * archiveService.ts'e DOKUNULMAZ.
 *
 * ONEMLI: zaman damgasi arsivlemenin ON KOSULU DEGIL, bir EKLENTIDIR. TSA'ya
 * ulasilamamasi (agin kesik olmasi, KamuSM'nin gecici olarak yanit vermemesi) arsiv
 * dosyasinin yazilip dogrulanmasini ENGELLEMEMELI - aksi halde harici bir servisin
 * gecici kesintisi, veri buyumesini durduran ana mekanizmayi kilitlerdi.
 */

export interface TimestampToken {
  /** TSA'nin dondurdugu, dogrulanabilir zaman damgasi jetonu (ör. base64 DER - RFC 3161 TimeStampToken). */
  token: string;
  /** TSA'nin bu ozet icin belirttigi an - sunucunun kendi saatine degil, TSA'nin saatine dayanir. */
  timestampedAt: string;
}

export interface TimestampAuthorityClient {
  /**
   * Verilen (arsiv dosyasinin) SHA-256 ozetini TSA'ya gonderip zaman damgasi ister.
   * TSA baglanmamis veya istek basarisiz olursa null doner - cagiran taraf bunu
   * "zaman damgasi alinamadi, arsivleme yine de tamamlandi" olarak ele alir.
   */
  requestTimestamp(sha256Hex: string): Promise<TimestampToken | null>;
}

export const noopTimestampAuthorityClient: TimestampAuthorityClient = {
  async requestTimestamp() {
    return null;
  },
};

let activeClient: TimestampAuthorityClient = noopTimestampAuthorityClient;

export function getTimestampAuthorityClient(): TimestampAuthorityClient {
  return activeClient;
}

/** KamuSM hesabi acilip gercek istemci yazildiginda, sunucu baslangicinda noop'un yerine bu ile takilir. */
export function setTimestampAuthorityClient(client: TimestampAuthorityClient): void {
  activeClient = client;
}
