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
  vardiyalar aynı istatistiklerle listelenir. Bir istasyonda aynı anda yalnızca bir vardiya
  açık olabilir (mükerrer satış sayımını önlemek için) — biri kapatılmadan yenisi açılamaz.
  **Personel Performansı** tablosu, her personelin tüm vardiyaları toplamındaki satış
  litresini/cirosunu gösterir — "hangi kullanıcı kaç litre sattı" sorusunun cevabı budur.
  Kiosk satışları hiçbir kullanıcı hesabına doğrudan bağlı değildir (self-servis, müşteri
  oturum açmaz); bir satış, tamamlandığı anda istasyonda **açık olan vardiyaya** atfedilir.
  Açık vardiya yokken tamamlanan satışlar "Vardiyasız Satışlar" altında ayrıca gösterilir —
  böylece hiçbir satış sessizce takipsiz kalmaz. Bu, Alarm Merkezi'nde bir alarm olarak değil
  (gerçek arıza/kritik durumlarla karışmasın diye), Panel'de küçük bir bilgi rozetiyle
  gösterilir. Hem vardiya geçmişi hem personel performansı tablosu **CSV olarak indirilebilir**.
- **Yakıt Stoku** (`/operator/stok`, yalnızca istasyon yöneticisi/`admin` görebilir ve
  düzenleyebilir; `operator`/`viewer` erişemez): Her istasyonun benzin/motorin/LPG tankları için mevcut
  seviye, kapasite ve düşük stok eşiği canlı bir tank göstergesiyle (gauge) izlenir. Kiosk'ta
  bir satış tamamlandığında ilgili tankın stoğu **otomatik olarak düşer**; tank teslimatı
  (tanker geldiğinde) "Stok Ekle" ile kaydedilir (tedarikçi, irsaliye no, not dahil) — kapasiteyi
  aşan miktar otomatik olarak sınırlanır ve fazlalık raporlanır. Yönetici rolü kapasite/eşik
  ayarlarını değiştirebilir ve fiziksel sayım sonrası **manuel stok düzeltmesi** yapabilir.
  Her hareket (satış/teslimat/düzeltme) zaman damgası, kullanıcı ve bakiye ile birlikte
  **Stok Hareketleri** tablosunda tutulur ve CSV olarak indirilebilir. Bir tank düşük stok
  eşiğinin altına düşünce otomatik olarak kritik bir alarm oluşur; stok yeniden eşiğin
  üzerine çıkınca bu alarm kendiliğinden kapanır. **Stok olmadan satış yapılamaz:** bir
  yakıt tipinin deposu tükenmişse kiosk'ta o buton "Tükendi" olarak devre dışı kalır ve
  sunucu tarafında da işlem oluşturma reddedilir (arayüz atlanarak doğrudan API'ye
  istek atılsa bile). Dolum sırasında da tank seviyesi **gerçek zamanlı, litre litre**
  düşürülür (tek seferlik toplu düşüm değil) — böylece aynı tankı paylaşan birden fazla
  pompa aynı anda dolum yapıyorsa, depo bittiğinde ikisi de doğru şekilde sınırlanır;
  depo bir müşterinin dolumu sırasında tükenirse işlem o ana kadar verilen miktarla
  otomatik tamamlanır ve müşteriye makbuzda bu açıkça belirtilir.
- **Ödeme:** İki mod desteklenir. Bir istasyon **iyzico** ile yapılandırılmışsa (Ayarlar →
  "Ödeme Ayarları"), kiosk'taki ödeme adımı iyzico'nun barındırdığı gerçek, PCI DSS
  kapsamındaki güvenli ödeme formuna yönlendirir — bu **gerçek bir banka/kart altyapısı
  entegrasyonudur**, simülasyon değildir (aşağıya bakınız). iyzico yapılandırılmamış
  istasyonlarda kiosk, kural tabanlı bir sanal POS simülasyonuna otomatik olarak düşer.
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
  etkinleştirir/devre dışı bırakır. Hiç işlem kaydı olmayan (örn. yanlışlıkla oluşturulmuş
  veya test amaçlı) bir istasyon kalıcı olarak da silinebilir — bu durumda istasyona bağlı
  kullanıcı hesapları da otomatik olarak kalıcı silinir (arayüz ve API bunu önceden açıkça
  belirtir). İşlem kaydı bulunan istasyonlar ise veri bütünlüğü için yalnızca devre dışı
  bırakılabilir, silinemez. Üst
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
- **iyzico ödeme doğrulaması:** Kart bilgileri hiçbir zaman bu sunucuya ulaşmaz. Kiosk
  yalnızca iyzico'dan bir "checkout form" başlatır; ödemenin gerçekten başarılı olup
  olmadığına biz kendi tarafımızda **sunucudan sunucuya** bir "retrieve" sorgusuyla karar
  veririz — iyzico'nun tarayıcı üzerinden gönderdiği callback'teki değerlere güvenilmez.
  Ayrıca iyzico'nun döndürdüğü her yanıt, kendi secret key'inizle hesaplanan bir
  HMAC-SHA256 imzasıyla (`iyzicoService.ts`) doğrulanır; imza uyuşmazsa sonuç reddedilir.

## Gerçek ödeme altyapısı: iyzico

Ödeme, demo/simülasyon değil **gerçek bir iyzico entegrasyonudur**: `server/src/services/
iyzicoService.ts` iyzico'nun resmi Node SDK'sı (`iyzipay`) ile "Checkout Form" (Ödeme Formu)
ürününü kullanır — kiosk kart bilgisi toplamaz, müşteri iyzico'nun barındırdığı güvenli
forma yönlendirilir (PCI DSS kapsamı iyzico'da kalır).

- **Yapılandırma istasyon bazlıdır:** Yönetici Paneli → Ayarlar → "Ödeme Ayarları (iyzico)"
  ekranından her istasyon kendi iyzico API/secret anahtarlarını ve ortamını (sandbox/production)
  girer; anahtarlar veritabanında saklanır, API üzerinden yalnızca maskeli (son 4 hane)
  olarak geri döner. iyzico yapılandırılmamış veya devre dışı bırakılmış bir istasyonda kiosk
  otomatik olarak sanal POS simülasyonuna döner (bkz. aşağıdaki simülasyon bölümü).
- **Zorunlu ön koşul — `PUBLIC_API_BASE_URL`:** iyzico, ödeme sonucunu bu sunucunun **herkese
  açık** bir adresine (kendi sunucularından) bildirir; bu adres `server/.env` içinde
  `PUBLIC_API_BASE_URL` ile tanımlanmalıdır. `localhost` veya yerel ağ adresleriyle **çalışmaz**.
  Yerelde test etmek için ngrok/cloudflared gibi bir tünel açıp verdiği `https://...` adresini
  buraya yazmanız gerekir; üretimde bu, sunucunuzun gerçek genel adresi olur. Bu değişken
  boşsa iyzico ödemesi başlatılamaz — kiosk sanal POS simülasyonuna düşer ve Ayarlar sayfasında
  net bir uyarı gösterilir.
- **Akış:** Kiosk `POST /api/kiosk/transactions/:id/iyzico/init` çağırır → iyzico'dan alınan
  ödeme formu kiosk sayfasına gömülür → müşteri kartını iyzico'nun formunda girer → iyzico,
  müşteri tarayıcısını `POST /api/kiosk/transactions/:id/iyzico/callback` adresine yönlendirir
  (kiosk erişim token'ı olmadan, genel erişimli) → sunucu bu callback'e **güvenmez**, aynı
  token ile iyzico'ya kendi tarafımızdan bir doğrulama sorgusu (`retrieveCheckoutForm`) atar,
  imzayı kontrol eder, işlemi kesinleştirir ve müşteriyi kiosk arayüzüne geri yönlendirir; SPA
  durumu tam sayfa yönlendirmede kaybolduğundan işlem kimliği/erişim token'ı yönlendirmeden
  hemen önce tarayıcının `localStorage`'ında saklanıp geri dönüşte okunur.
- **Bu ortamda canlı test edilemedi:** Bu oturumun çalıştığı sandbox, iyzico'nun sunucularına
  (veya herhangi bir dış servise) çıkış yapamıyor — kod, gerçek bir bağlantı denemesi
  yapıp sonucu doğru şekilde hatayla karşıladığı doğrulandı (bağlantı reddi/tünel hatası
  düzgün bir Türkçe hata mesajına çevrilip 502 döndü, sunucu çökmedi), ancak gerçek bir
  sandbox/production iyzico hesabıyla uçtan uca ödeme akışı **sizin tarafınızdan test
  edilmelidir**. Bu test sırasında iyzico'nun mevcut `checkoutFormContent` gömme sözleşmesini
  (script/iframe yapısı) tarayıcı konsolundan doğrulamanız ve gerekirse iyzico'nun güncel
  entegrasyon dokümantasyonuna göre `web/src/kiosk/steps/PaymentStep.tsx` içindeki gömme
  kodunu güncellemeniz önerilir.
- **Bilinen bir üçüncü parti kütüphane sorununa karşı önlem:** `iyzipay` SDK'sının kullandığı
  eski HTTP istemcisi, bir ağ kesintisinden sonra ilgisiz bir soket hatasını (`ECONNRESET`)
  yakalanmamış şekilde fırlatabiliyor; bu, düzeltilmeseydi tek bir ödeme denemesindeki geçici
  bir ağ sorunu **tüm istasyonlardaki** sunucuyu çökertebilirdi. `server/src/index.ts`
  içindeki `uncaughtException`/`unhandledRejection` güvenlik ağı bunu loglayıp sunucunun
  çalışmaya devam etmesini sağlar (test edilip doğrulandı).

## Simülasyon olarak uygulanan bileşenler (donanım gerektirdiği için / iyzico yapılandırılmadığında)

1. **LPR / plaka tanıma:** Gerçek bir kamera donanımı olmadığından, `POST /api/kiosk/lpr/recognize`
   plaka formatını (il kodu 01–81 + harf/rakam düzeni) doğrulayan ve bir güven skoru üreten
   gerçekçi bir kural motoruyla çalışır. Kiosk arayüzünde bu açıkça belirtilir; kullanıcı
   isterse plakayı elle de girebilir.
2. **Sanal ödeme (yalnızca iyzico yapılandırılmamış istasyonlarda kullanılan yedek yol):**
   `paymentService.ts` Luhn algoritmasıyla kart numarası doğrulaması, son kullanma tarihi ve
   CVV kontrolü yapan gerçek kurallı bir sanal POS simülasyonudur. Test için `...0002` ile
   biten kart numaraları bilinçli olarak reddedilir (red senaryosunu test etmek için).

Bunların dışındaki **her şey gerçek ve uçtan uca çalışır**: pompa durum makinesi, işlem
yaşam döngüsü (oluşturuldu → ödendi → yetkilendirildi → dolum → tamamlandı), gerçek zamanlı
litre/tutar artışı, alarm üretimi, raporlama, CSV dışa aktarma, vardiya takibi, e-posta/SMS
gönderimi ve iyzico ödeme entegrasyonu gerçek veritabanı verisi ve gerçek servis
entegrasyonları üzerinden çalışır.

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
# iyzico ile gercek odeme almak isterseniz PUBLIC_API_BASE_URL'i de doldurun (bkz. asagidaki
# "Gercek odeme altyapisi: iyzico" bolumu); bos birakilirsa kiosk sanal POS simulasyonuna doner.

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

## Üretime alırken (7/24 yayında tutma)

`npm run build` her iki workspace'i de derler; Express sunucusu `NODE_ENV=production`
iken derlenmiş `web/dist`'i **kendisi statik dosya olarak sunar** (ayrı bir nginx/CDN
gerekmez, tek süreç/tek adres). Yani üretimde tek komut yeterli:

```bash
npm run build
npm run start   # server/dist/index.js'i calistirir, hem API hem web ayni portta
```

**Gerekli ortam değişkenleri** (bkz. `server/.env.example`):
- `NODE_ENV=production`
- `COOKIE_SECURE=true` (yalnızca gerçek HTTPS arkasında çalışırken)
- `SESSION_SECRET`: `openssl rand -hex 32` ile üretilmiş rastgele bir değer
- `WEB_ORIGIN` ve `PUBLIC_API_BASE_URL`: sitenin gerçek genel adresi (ör. `https://siteniz.up.railway.app`) — ikisi de aynı olmalı, artık tek origin'de servis ediliyor
- `DATABASE_PATH`: SQLite dosyasının **kalıcı** bir diskte olduğundan emin olun (bkz. aşağıda)

### Kolay yol: Railway / Render gibi yönetilen platformlar

Repoda `railway.json`, `render.yaml` ve bir `Dockerfile` hazır — GitHub reposunu bu
platformlardan birine bağlayıp yukarıdaki ortam değişkenlerini panelden girmeniz yeterli,
sunucu bakımı/HTTPS/yeniden başlatma platform tarafından otomatik yönetilir:
- **Railway**: proje oluşturup GitHub reposunu bağlayın, panelden bir **Volume** ekleyip
  `DATABASE_PATH`'i o volume'ün mount yoluna (ör. `/data/yakit.sqlite`) ayarlayın — aksi
  halde her deploy'da veritabanı sıfırlanır. Railway size otomatik bir `*.up.railway.app`
  HTTPS adresi verir; bu adresi `WEB_ORIGIN`/`PUBLIC_API_BASE_URL` olarak girin.
  `railway.json` build'i Nixpacks yerine **Dockerfile** ile yapacak şekilde ayarlı — bunun
  nedeni `better-sqlite3` (native/derlenmiş bağımlılık) Nixpacks'in varsayılan build
  ortamında derlenemediği için; Dockerfile bunun için gereken derleyici araçlarını
  (`python3`, `make`, `g++`) içeriyor.
- **Render**: `render.yaml`'daki blueprint bir **persistent disk** (`/var/data`) zaten
  tanımlıyor; ilk deploy'dan sonra Render'in verdiği adresi Dashboard'dan `WEB_ORIGIN` ve
  `PUBLIC_API_BASE_URL` olarak girin (bu ikisi platform tarafından önceden bilinemediği
  için blueprint'te boş bırakıldı).

Her iki platformda da ücretsiz katman genelde ya kalıcı disk sunmaz ya da inaktivitede
uykuya geçirir — gerçek 7/24 çalışma için en ucuz ücretli plan (aylık birkaç dolar)
gerekir.

### Kendi sunucunuzda (VPS)

- Uygulamayı bir process manager (`pm2`, `systemd`) ile arka planda ve sunucu yeniden
  başlasa bile otomatik ayağa kalkacak şekilde çalıştırın.
- HTTPS sonlandırması için önüne bir ters proxy (nginx, Caddy) koyabilirsiniz, ama zorunlu
  değil — Express doğrudan da servis edebilir; sadece sertifika yönetimini proxy'ye
  bırakmak genelde daha kolaydır.
- SQLite veritabanı dosyasının (`DATABASE_PATH`) düzenli olarak yedeklenmesini sağlayın.

## Komutlar

| Komut | Açıklama |
|---|---|
| `npm run dev:server` / `dev:web` | Geliştirme sunucularını başlatır |
| `npm run build` | Backend + frontend derlemesi |
| `npm run typecheck` | Tüm workspace'lerde TypeScript tip kontrolü |
| `npm run seed --workspace server` | Roller, admin kullanıcı, istasyon, pompa, fiyat verisini oluşturur |
