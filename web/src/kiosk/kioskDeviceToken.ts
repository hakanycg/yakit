/**
 * Bu fiziksel kiosk'un cihaz tokeni.
 *
 * Kurulum: kiosk PC'sinde ekran BIR KEZ
 *   /kiosk/STM1234?device=<token>
 * adresiyle acilir. Token localStorage'a yazilir ve adres cubugundan temizlenir
 * (ekranda/gecmiste gorunmesin diye). Sonraki tum aciliszlarda saklanan token
 * kullanilir; kiosk API cagrilarina x-kiosk-device-token basligiyla eklenir
 * (bkz. shared/api.ts) ve sunucu istegi bu kiosk'un istasyonuna sabitler
 * (bkz. server/src/middleware/kioskDevice.ts).
 */
const STORAGE_KEY = "yakit_kiosk_device_token";
const QUERY_PARAM = "device";

export function getKioskDeviceToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Ozel/kisitli tarayici modlarinda localStorage erisimi hata atabilir.
    return null;
  }
}

/**
 * Adreste ?device=... varsa token'i kaydeder ve URL'den siler.
 * Kiosk uygulamasinin en basinda bir kez cagrilir.
 */
export function consumeKioskDeviceTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(QUERY_PARAM);
    if (!token) return;
    localStorage.setItem(STORAGE_KEY, token.trim());
    url.searchParams.delete(QUERY_PARAM);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    // URL/localStorage kullanilamiyorsa token'siz devam edilir; sunucu zaten
    // istasyonun ayarina gore reddedecektir.
  }
}
