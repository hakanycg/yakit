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

- **Kiosk** (`/kiosk`, herkese açık): Plaka girişi (manuel + LPR simülasyonu), pompa/yakıt/miktar
  seçimi, sanal kart ile ödeme, otomatik pompa yetkilendirme, canlı dolum ilerlemesi
  (WebSocket), işlem tamamlandı / fiş ekranı.
- **Operatör Paneli** (`/operator/*`, giriş gerektirir): Dashboard, 4 pompa canlı durumu,
  pompa başlat/durdur/reset, arıza simülasyonu, işlem listesi + CSV dışa aktarma, alarm
  merkezi, istasyon haritası, raporlama.
- **Yönetici Paneli** (`/admin/*`, yalnızca `admin` rolü): Kullanıcı/rol yönetimi, audit log,
  yakıt fiyatı ayarları, demo verilerini sıfırlama.

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
- **RBAC:** `admin` / `operator` / `viewer` rolleri; her endpoint sunucu tarafında rol
  kontrolünden geçer (yalnızca arayüz gizleme değildir).
- **Brute-force koruması:** 5 başarısız denemeden sonra hesap 15 dakika kilitlenir; ayrıca
  giriş uçları `express-rate-limit` ile IP bazlı sınırlandırılır.
- **Denetim günlüğü (audit log):** Giriş/çıkış, parola değişikliği, pompa işlemleri, alarm
  onay/çözüm, kullanıcı/ayar değişiklikleri, CSV dışa aktarma gibi tüm hassas eylemler
  kullanıcı, IP ve zaman damgasıyla kaydedilir; yalnızca `admin` görüntüleyebilir.
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
litre/tutar artışı, alarm üretimi, raporlama ve CSV dışa aktarma gerçek veritabanı verisi
üzerinden hesaplanır.

## Kurulum

```bash
npm install

cp server/.env.example server/.env
# server/.env içindeki SESSION_SECRET degerini `openssl rand -hex 32` ile uretilmis
# rastgele bir degerle degistirin.

npm run seed --workspace server   # roller, ilk admin kullanicisi, istasyon, 4 pompa, fiyatlar
npm run dev:server                # http://localhost:4000
npm run dev:web                   # http://localhost:5173 (ayri terminalde)
```

İlk giriş bilgileri `server/.env` dosyasındaki `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`
değerleridir (varsayılan: `admin` / `ChangeMe!12345`). İlk girişte parola değiştirme
zorunludur. **Üretime almadan önce mutlaka değiştirin.**

Kiosk ekranı: `http://localhost:5173/kiosk`
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
