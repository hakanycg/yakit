import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Bu bir "hosted" (barindirilan) Capacitor yapilandirmasidir: mobil uygulama kendi
 * icinde statik bir kopya TASIMAZ, dogrudan canli siteyi (server.url) bir WebView
 * icinde acar. Sebep: oturum cerezleri sameSite=strict ile isaretli (bkz.
 * server/src/middleware/auth.ts) - cerezin gonderilebilmesi icin WebView'in GERCEK
 * https origin'i yuklemesi sart; yerelde paketlenmis bir index.html (capacitor://
 * ya da https://localhost sahte origin'i) bu cerezle calismaz.
 *
 * appId ONEMLI: magaza yayinindan sonra DEGISTIRILEMEZ. Asagidaki "com.yakit.app"
 * bir yer tutucudur - yayina almadan once kendi ters-alan-adi (reverse-DNS)
 * degerinizle degistirin (ör. sirket alan adiniz varsa com.sirketiniz.yakit).
 */
const PRODUCTION_URL = process.env.CAPACITOR_SERVER_URL ?? "https://yakit-production.up.railway.app";

const config: CapacitorConfig = {
  appId: "com.yakit.app",
  appName: "Yakıt Yönetim",
  webDir: "dist",
  server: {
    url: PRODUCTION_URL,
    // WEB_ORIGIN/PUBLIC_API_BASE_URL zaten https - cleartext (http) trafiginin
    // yanlislikla acilmasini engelle.
    cleartext: false,
    androidScheme: "https",
  },
};

export default config;
