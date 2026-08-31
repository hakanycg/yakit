# Mobil kabuklar (App Store / Play Store)

Bu dizin, ana `web/` uygulamasını App Store ve Play Store'a çıkarmak için
[Capacitor](https://capacitorjs.com) ile hazırlanmış iki **native kabuk**
içerir. İkisi de "hosted mode"da çalışır: kendi içlerine web kodu GÖMMEZLER,
WebView'i doğrudan üretimdeki gerçek HTTPS adresine yönlendirirler. Bu sayede
mevcut cookie tabanlı oturum/CORS/CSP ayarlarının hiçbirine dokunulmadı —
uygulama, tarayıcıdan siteyi ziyaret etmekle birebir aynı origin'de çalışır.

```
mobile/
  operator-app/   -> com.yakit.operator, /giris adresini acar (yonetim paneli)
  fleet-app/      -> com.yakit.fleet, /filo adresini acar (filo musteri portali)
```

## Yapılan hazırlık (hesap gerektirmeden tamamlandı)

- Her iki proje için Capacitor + Android/iOS native proje iskeleti (`npx cap
  add android/ios`) üretildi, ayrı bundle ID'lerle doğrulandı
- **Splash screen** ve **durum çubuğu** tamamen config üzerinden (native kod
  YAZILMADI — `@capacitor/splash-screen`/`@capacitor/status-bar` bu ayarları
  `capacitor.config.json`'dan native olarak okuyup uyguluyor): koyu tema
  (`#0b0f14`, sitenin kendi `--bg` rengiyle aynı), 3 saniyelik splash
  (uzaktaki sayfa yüklenene kadar beyaz ekran görünmesin diye)
- Android geri tuşu ve WebView geçmişi Capacitor'ın **varsayılan** davranışı
  (ek kod gerekmedi)
- Bağımlılıklarda yüksek/kritik güvenlik açığı YOK — `@capacitor/assets`
  (ikon üretim aracı, sharp/tar zincirinde yüksek/kritik açıklar taşıyordu)
  kalıcı bağımlılık olarak eklenmedi; ikon üretilirken tek seferlik `npx
  @capacitor/assets generate` olarak çalıştırılacak. Kalan 3 orta seviye
  bulgu, `@capacitor/cli`'ın kendi `uuid`/`xcode` zincirinde (yalnızca
  geliştirme aracı, uygulamaya hiç dahil olmuyor, üretimde çalışmıyor) —
  upstream'de düzeltmesi henüz yok.

## BİLEREK bu turda yapılmayan: biyometrik kilit

Face ID/Touch ID/Android biyometri ile "WebView gösterilmeden önce kilit"
özelliği ilk planda vardı ama gerçek native kod (Swift + Kotlin) gerektiriyor
— bu ortamda Xcode/Android SDK olmadığı için yazılan native kodu DERLEYİP
DOĞRULAYAMAM. Yanlış/derlenmeyen native kod bırakmaktansa, bu adımı Xcode/
Android Studio'yu açtığınızda (imzalama için zaten gerekecek) birlikte
eklemek üzere bıraktım. `@aparajita/capacitor-biometric-auth` paketinin
[resmi kurulum kılavuzu](https://github.com/aparajita/capacitor-biometric-auth)
bunun için iyi bir başlangıç noktası.

## `capacitor.config.json` içindeki `server.url` YER TUTUCUSU

Her iki dosyada da `https://REPLACE_WITH_PRODUCTION_DOMAIN/...` var —
Railway'deki gerçek üretim adresiyle değiştirilmeli. `StatusBar.style` alanı
Capacitor'ın kendi (kafa karıştırıcı) adlandırmasıyla: `"DARK"` = koyu
arka planlar için AÇIK (beyaz) yazı rengi — bilerek böyle, koyu temamızla
tutarlı.

## Sırada: sizin yapmanız gerekenler

1. **Üretim HTTPS alan adı**: her iki `capacitor.config.json`'daki
   `REPLACE_WITH_PRODUCTION_DOMAIN`'i gerçek Railway adresiyle değiştirin
2. **Marka logosu**: kare (1024×1024 önerilir) bir logo dosyası verirseniz
   `npx @capacitor/assets generate --iconBackgroundColor '#0b0f14' --splashBackgroundColor '#0b0f14'`
   ile tüm ikon/splash boyutları tek seferde üretilir (paket kalıcı
   bağımlılık değil, yalnızca bu komutu çalıştırırken indirilir)
3. **Bir Mac** (kendi cihazınız ya da bulut Mac CI): Xcode yalnızca macOS'ta
   çalışır — iOS projesini derlemek, simülatörde/gerçek cihazda test etmek
   ve App Store'a göndermek için gerekli
4. **Apple Developer Program** ($99/yıl): App Store Connect'te uygulama
   oluşturmak, imzalama sertifikası/provisioning profile almak için zorunlu
5. **Google Play Console hesabı** ($25 tek seferlik): yalnızca YAYINLAMA
   için gerekli — Android derleme/emülatör testi hesapsız da yapılabiliyor
   (`npm run run:android` bu dizinlerde, Android SDK kurulu bir makinede)
6. Biyometrik kilidi eklemek isterseniz yukarıdaki paketin kurulum
   kılavuzunu izleyin (opsiyonel — hosted-mode kabuk onsuz da çalışır)
7. Her iki mağaza için ekran görüntüleri, kısa açıklama, gizlilik politikası
   URL'si (ikisi de zorunlu tutuyor)

## Doğrulama

Bu ortamda (Linux, Xcode/Android SDK yok) doğrulanan: her iki projenin
`npm install`, `npx cap add android/ios`, `npx cap sync` adımlarının hatasız
tamamlandığı, ayrı bundle ID'lerin (`com.yakit.operator` / `com.yakit.fleet`)
hem Android (`build.gradle`) hem iOS (`project.pbxproj`) tarafında doğru
yansıdığı. Gerçek derleme/çalıştırma/ekran görüntüsü Android için SDK kurulu
bir makinede (`npm run run:android`), iOS için bir Mac'te (`npm run
open:ios` → Xcode'da Run) yapılmalı.
