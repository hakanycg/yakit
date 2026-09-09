import { useEffect } from "react";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { api } from "./api";

/**
 * Kritik alarm mobil push bildirimi (bkz. server/src/services/pushNotificationService.ts) -
 * yalnizca GERCEK bir yerel (native) Capacitor kabugu icinde (bkz. web/capacitor.config.ts -
 * bu "hosted" yapilandirma, ayni web uygulamasini bir Android WebView icinde acar) bir sey
 * yapar; normal tarayicida Capacitor.isNativePlatform() false doner ve hic calismaz.
 *
 * Izin istenir -> kabul edilirse cihaz FCM token'i icin kayit olunur -> token gelince
 * sunucuya kaydedilir (POST /api/push-tokens). Sunucu tarafinda ayrica bir kullanici
 * tercihi (notify_push, bkz. NotificationSettings.tsx) vardir - bu hook yalnizca cihazi
 * KAYDEDER, gonderilip gonderilmeyecegine sunucu tarafi karar verir.
 *
 * SAHA NOTU: bu kodun calismasi icin (yalnizca yazmakla degil) su adimlar GEREKIR -
 * (1) `npx cap sync android` (bu paket package.json'a eklendi ama native projeye
 * kaydi cap sync gerektirir), (2) Firebase konsolundan alinan google-services.json
 * dosyasinin web/android/app/ altina konmasi - ikisi de bu ortamda (Android SDK yok)
 * calistirilamaz/saglanamaz, gercek cihazda derlemeden once yapilmalidir.
 */
export function useMobilePush(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !Capacitor.isNativePlatform()) return;

    let registrationHandle: PluginListenerHandle | null = null;
    let errorHandle: PluginListenerHandle | null = null;
    let cancelled = false;

    async function setup() {
      const status = await PushNotifications.requestPermissions();
      if (cancelled || status.receive !== "granted") return;

      registrationHandle = await PushNotifications.addListener("registration", (token) => {
        void api.post("/api/push-tokens", { token: token.value, platform: Capacitor.getPlatform() }).catch(() => {
          // Kayit basarisiz olsa da uygulamanin geri kalanini etkilememeli - en kotu
          // ihtimalle bu cihaz push bildirimi almaz, e-posta/SMS kanallari calismaya devam eder.
        });
      });
      errorHandle = await PushNotifications.addListener("registrationError", () => {});

      await PushNotifications.register();
    }
    void setup();

    return () => {
      cancelled = true;
      registrationHandle?.remove();
      errorHandle?.remove();
    };
  }, [enabled]);
}
