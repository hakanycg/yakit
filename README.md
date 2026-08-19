# Yakıt İstasyonu Self-Servis Sistemi

Sürücülerin görevli olmadan araçlarına yakıt doldurup kiosk üzerinden ödeme yapabildiği,
istasyon operatörlerinin pompaları ve işlemleri gerçek zamanlı izleyip yönetebildiği,
yöneticilerin kullanıcı/rol, denetim kaydı ve sistem ayarlarını kontrol edebildiği uçtan
uca çalışan bir yakıt istasyonu otomasyon sistemi.

Bu bir demo/prototip değildir: kimlik doğrulama, oturum yönetimi, yetkilendirme (RBAC),
CSRF koruması, parola politikası, hesap kilitleme, denetim günlüğü (audit log) ve veri
kalıcılığı (SQLite) gerçek şekilde uygulanmıştır. Fiziksel donanım gerektiren iki bileşen
(plaka tanıma kamerası / ANPR ve banka POS ağı) bu ortamda mevcut olmadığından, bu ikisi
**gerçekçi kurallarla çalışan yazılım simülasyonları** olarak uygulanmıştır (aşağıya bakınız).

## Mimari

```
yakit/
├── server/    Node.js + TypeScript + Express + SQLite (better-sqlite3) + WebSocket (ws)
└── web/       React + TypeScript + Vite (Kiosk, Operatör Paneli, Yönetici Paneli)
```

- **Kiosk** (`/kiosk/:slug`, herkese açık): Plaka girişi (manuel + LPR simülasyonu), pompa/yakıt/miktar
  seçimi, sanal kart ile ödeme, otomatik pompa yetkilendirme, canlı dolum ilerlemesi
  (WebSocket), işlem tamamlandı / fiş ekranı. Her istasyonun kendine özel kiosk adresi
  (`slug`) vardır; birden fazla istasyonunuz varsa her biri için ayrı bir kiosk URL'si olur.
- **Operatör Paneli** (`/operator/*`, giriş gerektirir): Dashboard, pompa canlı durumu,
  pompa başlat/durdur/reset, arıza simülasyonu, işlem listesi + CSV dışa aktarma, alarm
  merkezi, istasyon haritası, raporlama, vardiya yönetimi. Her zaman yalnızca kullanıcının
  bağlı olduğu istasyonun verisini gösterir.
- **Vardiya yönetimi** (`/operator/vardiya`): Operatör/yönetici vardiya başlatıp bitirebilir;
  açık vardiyanın canlı süresi, işlem sayısı, cirosu ve litre toplamı gösterilir; geçmiş
  vardiyalar aynı istatistiklerle listelenir.
- **Makbuz gönderimi:** Kiosk'ta işlem tamamlandığında müşteri isterse e-posta ve/veya SMS
  ile makbuz alabilir (`POST /api/kiosk/transactions/:id/receipt`).
- **Kritik alarm bildirimleri:** Bir pompa arızası gibi kritik önem düzeyinde bir alarm
  oluştuğunda, istasyondaki bildirim tercihi açık olan admin/operatör kullanıcılarına
  otomatik e-posta/SMS gönderilir; ayrıca panel açıkken tarayıcı bildirimi (Web Notification
  API) gösterilir. Her kullanıcı kendi e-posta/telefon/bildirim tercihini
  **Hesabım → Bildirim Ayarları** sayfasından yönetir.
- **İstasyon Yönetimi** (`/admin/*`, `admin` rolü): Kullanıcı/rol yönetimi, audit log,
  yakıt fiyatı ayarları, demo verilerini sıfırlama — hepsi yalnızca kendi istasyonuyla sınırlı.
- **Platform Yönetimi** (`/admin/istasyonlar`, yalnızca `super_admin` rolü): Tüm istasyonları
  listeler, yeni istasyon (+ istasyon yöneticisi hesabı) oluşturur, istasyonları
  etkinleştirir/devre dışı bırakır. Hiç işlemi veya kullanıcısı olmayan (örn. yanlışlıkla
  oluşturulmuş veya test amaçlı) bir istasyon kalıcı olarak da silinebilir; işlem/kullanıcı
  kaydı bulunan istasyonlar veri bütünlüğü için yalnızca devre dışı bırakılabilir. Üst
  menüdeki istasyon değiştirici ile herhangi bir
  istasyonun operatör/yönetici panelini görüntüleyebilir — tıpkı o istasyonun kendi
  yöneticisiymiş gibi, ama tüm istasyonlara erişimi olan tek roldür. Ürünün satışı
  sonrasında müşteri hizmetleri ekibine bu rolü vererek tüm istasyonlara destek erişimi
  sağlayabilirsiniz; her istasyon sahibi ise yalnızca kendi istasyonunun verisini görür.

## Güvenlik

- **Parola saklama:** PBKDF2-SHA512, kullanıcıya özel rastgele tuz, 210.000 iterasyon;
  doğrulama sabit zamanlı (`timingSafeEqual`) karşılaştırma ile yapılır.
- **Parola politikası:** min. 10 karakter, büyük/küçük harf, rakam ve özel karakter zorunlu.
- **Oturumlar:** Sunucu tarafında SQLite'ta saklanan, rastgele 256-bit token'lı, sliding
  30 dakika boşta kalma + 12 saat mutlak süre sınırlı oturumlar. Token veritabanında yalnızca
  SHA-256 hash'i olarak tutulur (DB sızıntısında doğrudan tekrar kullanılamaz).
- **Çerezler:** `httpOnly`, `SameSite=Strict`, üretimde `Secure` (env ile zorunlu kılınabilir).
- **CSRF koruması:** Çift-gönderim (double-submit) deseni; durum değiştiren her istek
  `X-CSRF-Token` başlığını, oturumla eşleşen token ile birlikte göndermek zorundadır.
- **RBAC + çoklu istasyon (multi-tenant) izolasyonu:** `super_admin` / `admin` / `operator` /
  `viewer` rolleri. `super_admin` dışındaki her kullanıcı tam olarak bir istasyona bağlıdır
  (`users.station_id`) ve sunucu tarafında bu istasyonun dışına asla çıkamaz — pompalar,
  işlemler, alarmlar, raporlar, kullanıcılar, yakıt fiyatları ve audit log dahil her sorgu
  `station_id` ile filtrelenir; bu filtre istemciden gelen parametrelere değil, oturumdaki
  kullanıcının kendi `station_id`'sine dayanır, dolayısıyla bir istasyon yöneticisi başka bir
  istasyonun verisini URL/parametre değiştirerek göremez. `super_admin` tüm istasyonlara
  erişebilir ve üst menüdeki istasyon değiştirici ile hangi istasyona "baktığını" seçer.
- **Brute-force koruması:** 5 başarısız denemeden sonra hesap 15 dakika kilitlenir; ayrıca
  giriş uçları `express-rate-limit` ile IP bazlı sınırlandırılır.
- **Denetim günlüğü (audit log):** Giriş/çıkış, parola değişikliği, pompa işlemleri, alarm
  onay/çözüm, kullanıcı/ayar değişiklikleri, CSV dışa aktarma gibi tüm hassas eylemler
  kullanıcı, IP ve zaman damgasıyla kaydedilir; yalnızca `admin`/`super_admin` görüntüleyebilir
  ve kayıtlar da istasyona göre etiketlenip filtrelenir.
- **Girdi doğrulama:** Tüm istek gövdeleri/parametreleri `zod` şemalarıyla katı şekilde
  doğrulanır; SQL enjeksiyonuna karşı tüm sorgular parametreli (`better-sqlite3` prepared
  statement) çalışır.
- **HTTP güvenlik başlıkları:** `helmet` ile CSP, HSTS (üretimde), `X-Frame-Options`,
  `X-Content-Type-Options` vb. otomatik uygulanır; CORS yalnızca yapılandırılan `WEB_ORIGIN`
  için ve `credentials: true` ile açılır.
- **Kiosk-terminal ayrımı:** Her kiosk işlemi, yalnızca o terminalin bildiği tek kullanımlık
  bir erişim token'ı (`kiosk_access_token`) ile korunur; başka bir terminalden veya
  tarayıcıdan aynı işlem numarasıyla veri/ödeme erişimi mümkün değildir. WebSocket üzerinden
  işlem detaylarına abone olmak da bu token'ın doğrulanmasını gerektirir.
- **Az yetki ilkesi:** Kiosk uçları kullanıcı oturumu gerektirmez ve yalnızca işlem
  yaşam döngüsüyle sınırlıdır; yönetimsel uçların tamamı `requireAuth` + `requireRole` +
  `csrfProtection` zincirinden geçer.

## Simülasyon olarak uygulanan iki bileşen (donanım gerektirdiği için)

1. **LPR / plaka tanıma:** Gerçek bir kamera donanımı olmadığından, `POST /api/kiosk/lpr/recognize`
   plaka formatını (il kodu 01–81 + harf/rakam düzeni) doğrulayan ve bir güven skoru üreten
   gerçekçi bir kural motoruyla çalışır. Kiosk arayüzünde bu açıkça belirtilir; kullanıcı
   isterse plakayı elle de girebilir.
2. **Sanal ödeme (POS/banka ağı):** Gerçek bir ödeme ağı entegrasyonu olmadığından,
   `paymentService.ts` Luhn algoritmasıyla kart numarası doğrulaması, son kullanma tarihi ve
   CVV kontrolü yapan gerçek kurallı bir sanal POS simülasyonudur. Test için `...0002` ile
   biten kart numaraları bilinçli olarak reddedilir (red senaryosunu test etmek için).

Bunların dışındaki **her şey gerçek ve uçtan uca çalışır**: pompa durum makinesi, işlem
yaşam döngüsü (oluşturuldu → ödendi → yetkilendirildi → dolum → tamamlandı), gerçek zamanlı
litre/tutar artışı, alarm üretimi, raporlama, CSV dışa aktarma, vardiya takibi ve e-posta/SMS
gönderimi gerçek veritabanı verisi ve gerçek servis entegrasyonları üzerinden çalışır.

### E-posta/SMS için kendi sağlayıcınızı bağlamanız gerekir

Makbuz gönderimi ve kritik alarm bildirimleri kod olarak tam çalışır durumdadır (nodemailer
ile gerçek SMTP, genel bir HTTP tabanlı SMS webhook'u), ancak **bir e-posta/SMS sağlayıcı
hesabınız olmadan** hiçbir yere gönderim yapamaz — `server/.env` içindeki `SMTP_*` / `SMS_*`
değerleri boşsa sistem çökmez, sadece "yapılandırılmamış" uyarısı loglayıp o kanalı atlar.
Gerçek gönderim için kendi SMTP hesabınızı (Gmail, SendGrid, kurumsal SMTP vb.) ve bir SMS
sağlayıcısının (Netgsm, İletimerkezi, Twilio vb.) REST endpoint bilgilerini `server/.env`'e
girmeniz yeterlidir; SMS sağlayıcınızın istek formatı farklıysa
`server/src/services/notificationService.ts` içindeki `sendSms` fonksiyonunu ona göre uyarlayın.

## Kurulum

```bash
npm install

cp server/.env.example server/.env
# server/.env içindeki SESSION_SECRET degerini `openssl rand -hex 32` ile uretilmis
# rastgele bir degerle degistirin.

npm run seed --workspace server   # roller, super_admin, ilk istasyon + istasyon yoneticisi, 4 pompa, fiyatlar
npm run dev:server                # http://localhost:4000
npm run dev:web                   # http://localhost:5173 (ayri terminalde)
```

Seed script'i iki hesap oluşturur (ikisi de `SEED_ADMIN_PASSWORD` şifresiyle, varsayılan
`ChangeMe!12345`, ilk girişte değiştirme zorunlu):
- `admin` (`SEED_ADMIN_USERNAME`): **süper admin**, tüm istasyonlara erişir.
- `merkez-admin`: ilk istasyonun (**Merkez Yakıt İstasyonu**) yöneticisi, yalnızca bu istasyonu görür.

Yeni bir istasyon eklemek için süper admin ile giriş yapıp **Platform → İstasyonlar →
Yeni İstasyon**'u kullanın; formda doğrudan o istasyonun ilk yöneticisini de oluşturabilirsiniz.

Kiosk ekranı: `http://localhost:5173/kiosk/merkez` (istasyonun `slug` değeri URL'de kullanılır)
Personel girişi: `http://localhost:5173/giris`

## Üretime alırken

- `server/.env`: `NODE_ENV=production`, `COOKIE_SECURE=true`, güçlü/rastgele `SESSION_SECRET`.
- Uygulamayı HTTPS sonlandıran bir ters proxy (nginx, Caddy vb.) arkasında çalıştırın.
- `npm run build` her iki workspace'i de derler; `server/dist` Node ile, `web/dist` statik
  dosya olarak (nginx veya benzeri) sunulabilir.
- SQLite veritabanı dosyasının düzenli olarak yedeklenmesini sağlayın.

## Komutlar

| Komut | Açıklama |
|---|---|
| `npm run dev:server` / `dev:web` | Geliştirme sunucularını başlatır |
| `npm run build` | Backend + frontend derlemesi |
| `npm run typecheck` | Tüm workspace'lerde TypeScript tip kontrolü |
| `npm run seed --workspace server` | Roller, admin kullanıcı, istasyon, pompa, fiyat verisini oluşturur |
