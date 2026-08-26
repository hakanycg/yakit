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

- **Kiosk** (`/kiosk/:kod`, ör. `/kiosk/STM1234`): Plaka girişi (manuel + LPR simülasyonu), pompa/yakıt/miktar
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

## Konsolide (çok istasyonlu) rapor

**Konsolide Rapor** ekranı tüm istasyonları tek tabloda gösterir: istasyon bazında ciro,
indirim, litre, kümülatif yakıt sapması, açık/kritik alarm, açık destek talebi ve son
senkron zamanı — ciroya göre sıralı, CSV çıktılı.

Buna ihtiyaç kiracı katmanıyla doğdu: 40 istasyonu olan bir dağıtıcı, toplam cirosunu
görmek için 40 istasyonu tek tek gezmek zorunda kalıyordu (sistemdeki tek raporlama ucu
`/api/reports/summary` idi ve tek istasyona bakıyordu).

### Kapsam

`/api/portfolio` istasyonlar **arası** çalışır, yani `attachStationScope`'un
`?stationId=` kapısından geçmez — kiracı filtresini kendisi uygular: platform yöneticisi
hepsini görür, dağıtım şirketi yöneticisi yalnızca kendi istasyonlarını. Tek istasyonlu
roller bu uca erişemez; zaten tek istasyonları var.

### Aynı "bugün"

Tarih aralığı, Gün Sonu Mutabakatı ile **aynı** iş günü tanımını kullanır (Türkiye UTC+3,
`utils/businessDay.ts`). İki ekranın "bugün"ü farklı anlaması, aynı gün için farklı
rakamlar göstermeleri demek olurdu; bu yüzden sınır tek yerde tanımlıdır.

### İki ayrım

- **Satışı olmayan istasyon listeden düşmez**, sıfır değerlerle görünür. Düşseydi
  "istasyonum kayboldu" izlenimi verirdi; oysa bilgi "bu aralıkta hiç satış yok".
- **Ölçümü olmayan istasyonda sapma `null`**, sıfır değil. `0` yazmak "ölçtük, fark yok"
  demek olurdu — ölçüm yokluğu başka bir şey.

## Dağıtım şirketi (kiracı) katmanı

Sistem tek bir işletmeye değil, birden fazla **dağıtım şirketine** hizmet verebilir.
Her dağıtıcı yalnızca kendisine atanmış istasyonları görür; başka bir şirketin
verisine hiçbir yoldan erişemez.

### İzolasyon nerede zorlanıyor?

**Tek yerde: `attachStationScope`** (`middleware/auth.ts`). İstasyona bağlı bütün veri
(pompa, işlem, alarm, stok, rapor, ayar, mutabakat…) rotalarda `req.stationId` üzerinden
okunuyor. Dolayısıyla *"bu kullanıcı hangi istasyona erişebilir"* sorusunu orada
cevaplamak bütün sorguları kapsar — her sorguya ayrı ayrı kiracı koşulu eklemek
gerekmez, ki bu yaklaşım tek bir unutulan sorguda sızıntı demek olurdu.

İstasyonlar **arası** çalışan uçlar (istasyon listesi, kiosk filosu, kullanıcı yönetimi)
bu akışın dışında kalır ve kendi filtrelerini uygulamak **zorundadır**;
`middleware/tenantScope.ts` o filtreyi tek yerde toplar.

### Roller

| Rol | Kapsam |
| --- | --- |
| `super_admin` | Platform. Tüm istasyonlar, dağıtım şirketi açma/kapama, istasyon atama. |
| `tenant_admin` | Bir dağıtım şirketi. Yalnızca kendi istasyonları; içlerinde istasyon yöneticisi yetkileri. |
| `admin` / `operator` / `viewer` | Tek bir istasyon (değişmedi). |

Kiracı açmak, istasyon atamak ve `tenant_admin` hesabı oluşturmak **ticari** kararlardır
(kimin neyi işlettiği, faturalama) — yalnızca platform yöneticisi yapabilir. Bir
dağıtıcının kendine istasyon eklemesi veya başka bir kiracı yöneticisi açması engellenir.

Aynı sebeple istasyon **oluşturma** ve **silme** de platforma özeldir: silme geri
alınamaz ve o istasyonun tüm verisini etkiler.

### Sızdırmayan hata mesajları

Erişilemeyen bir istasyon ile **var olmayan** bir istasyon aynı cevabı alır (403).
"Bulunamadı" demek, hangi id'lerin var olduğunu sızdırırdı.

### İstemciye güvenilmez

Sidebar'daki istasyon listesini sunucu belirler: `/api/stations`, `tenant_admin`'e
yalnızca kendi kiracısının istasyonlarını döner. Menüde neyin göründüğü kolaylık
içindir; izolasyon her zaman sunucuda zorlanır.

## Filo hesapları ekranı

Hesap listesi sekiz sütunlu bir tabloydu; telefonda yatay kaydırma gerektiriyor ve eylem
düğmeleri ekranın dışında kalıyordu. Artık İstasyonlar/Destek Talepleri ile aynı desende:
**liste tek satır**, detayın tamamı satıra tıklanınca açılan pencerede.

Detay penceresinde **plakalar rozet olarak** dizilir. Satır düzeninde 10 araçlık bir filo 10 satır
+ 10 kocaman "Kaldır" düğmesi demekti: pencere ekrandan taşıyor, yanındaki bakiye formu boş boşluk
olarak kalıyordu. Rozet düzeninde aynı 10 plaka iki satıra sığar. Pencere de genişletildi
(`modal-xl`, 1040px): içinde plakalar, bakiye, iletişim, dönem faturası, portal erişimi ve hareket
geçmişi olan bir ekran 720px'te dar iki sütuna sıkışıyordu.

Telefonda pencere neredeyse tam ekran açılır, iç dolgu bir kademe azalır, tutarlar şirket adının
altına iner ve "Pasife Al" tam genişlikte alta geçer.

## Filo müşteri self-servis portalı (`/filo`)

Bir filo müşterisi — 30 kamyonu olan bir nakliye şirketi — bugüne kadar kendi hesabını
hiç göremiyordu. Bakiyesini, hangi aracın ne zaman ne kadar yakıt aldığını öğrenmek için
istasyonu telefonla araması gerekiyordu. Düşük bakiye uyarısı şirkete gidiyordu ama şirket
o uyarıyla hiçbir şey yapamıyordu: *"ne harcadık da bitti?"* sorusunun cevabı yine
istasyondaydı.

`/filo` adresi şirket yetkilisine kendi hesabını açar:

- Kalan bakiye (veya faturalı hesapta ödenmemiş borç) ve harcanabilir tutar
- Seçilen tarih aralığında **araç bazında** dolum sayısı, litre ve tutar
- Hesap ekstresi (yakıt alımı / bakiye yükleme / iade / düzeltme) ve **CSV indirme**
- Kendi şifresini değiştirme

Erişim istasyondan verilir: **Filo Hesapları → hesap detayı → Portal Erişimi**. Sistem bir
**geçici şifre** üretir; bu şifre yalnızca o ekranda **bir kez** gösterilir, hiçbir yerde
saklanmaz ve denetim izine de yazılmaz (audit log'u okuyabilen herkes o hesaba girebilir
hale gelirdi). Yetkili ilk girişinde kendi şifresini belirlemek zorundadır.

### Kimlik neden personel oturumundan ayrı?

Şirket yetkilisi **personel değildir**. `users` tablosuna bir rol olarak eklenseydi,
`requireAuth` kullanıp ayrıca rol kontrolü yapmayan **her uç** onu kabul ederdi — tek bir
eksik kontrol dış bir şirkete istasyon verisi açardı. Bu yüzden portal kimliği baştan aşağı
ayrıdır: ayrı tablo (`fleet_portal_users`), ayrı oturum tablosu, ayrı çerez
(`yakit_fleet_sid` / `yakit_fleet_csrf`) ve ayrı middleware
(`middleware/fleetPortalAuth.ts`). Aynı gerekçe kiosk cihaz tokeni için de geçerlidir.

Ayrı çerez adı, aynı tarayıcıda hem personel hem müşteri oturumunun yan yana durabilmesini
de sağlar.

Kapsam kontrolü **tek yerde**: bütün müşteri uçları `assertAccountAccess` üzerinden geçer
ve hangi hesaplara erişilebildiğini `fleet_portal_user_accounts` belirler —
`attachStationScope`'un personel tarafında oynadığı rolün aynısı. Erişilemeyen hesapla var
olmayan hesap **aynı** cevabı döner (404); giriş ekranında da yanlış şifre ile olmayan
e-posta aynı cevabı verir, aksi halde portal bir şirketin bizde hesabı olup olmadığını
sızdıran bir sorgu aracı olurdu. Personel girişindeki savunmalar da aynen geçerli: sabit iş
yükü (kullanıcı bulunamasa da bir PBKDF2 doğrulaması yapılır) ve 5 başarısız denemede 15
dakika kilit.

### Portal salt okunurdur

Yetkili **kendi şifresi dışında hiçbir şey yazamaz**. Bakiye yükleme parayla ilgilidir ve
istasyonda kalır; portaldaki düşük bakiye uyarısı da kullanıcıyı istasyona yönlendirir.

### Bir şirket, birden fazla istasyon

Filo hesapları istasyon bazlıdır: bir şirket zincirin üç istasyonunda yakıt alıyorsa üç ayrı
`fleet_accounts` kaydı olur. Portal kullanıcısı **birden fazla hesaba bağlanabilir** (aynı
e-posta ikinci bir hesaba eklendiğinde yeni şifre üretilmez, mevcut şifresi de
değiştirilmez — bu, o kişinin diğer istasyondaki erişimini bozardı); portalda hesaplar
arasında geçiş yapılır. Erişim kaldırıldığında ya da hesap devre dışı bırakıldığında açık
oturumlar **anında** düşer; şifre değişiminde de tüm oturumlar kapanır.

### Ekstre neden hareket defterinden üretiliyor?

Ekstre `fleet_movements` üzerinden çıkarılır, işlemler üzerinden değil. İşlemlerden ayrı bir
"dolumlar" listesi çıkarılsaydı bakiyeyle tutmayan bir tablo elde ederdik: iptal edilip
iadesi yapılmış bir dolum listede görünür ama bakiyeye yansımamış olurdu. Defter neyse
bakiye odur; müşteriye de o gösterilir. Gün sınırı Türkiye saatiyle gece yarısıdır — gün
sonu mutabakatı ve konsolide raporla **aynı** tanım (bkz. `utils/businessDay.ts`), böylece
müşteri ile istasyon aynı gün için farklı rakam görmez.

## Filo dönem (icmal) faturası

Sonradan faturalı (postpaid) bir filo hesabında borç birikiyor, personel ödeme kaydı
girebiliyordu — ama arada **fatura yoktu**. Mevcut e-Fatura yolu ise tek bir işleme
bağlıdır (`invoices` tablosunda `UNIQUE(transaction_id)`) ve alıcı kimliği kiosk'ta
toplanmadığı için VKN'siz **"Nihai Tüketici" e-Arşiv** olarak kesilir. Kurumsal bir
müşteri için bu iki yönden de yanlıştır: ayda 200 kez dolum yapan nakliye şirketine 200
perakende fişi değil, **kendi VKN'siyle dönem başına tek e-Fatura** gerekir.

**Filo Hesapları → hesap detayı → Dönem Faturası** bölümünden kesilir. Ekran önce
kesilecek faturanın önizlemesini gösterir (kaç hareket, hangi araç hangi yakıttan ne kadar,
KDV hariç/KDV/toplam), sonra "Fatura Kes" ile Uyumsoft'a gönderilir. Müşteri de kendi
faturalarını `/filo` portalında görür.

### Kapsam tarihle değil, hareketle belirlenir

Fatura *"1–31 Ağustos arası"* diye seçilseydi, 30 Ağustos'ta girilmiş ama 2 Eylül'de fark
edilen bir hareket ya iki kez faturalanır ya da hiç faturalanmazdı. Onun yerine her hareket
faturalandığında `fleet_movements.fleet_invoice_id` yazılır; bir sonraki fatura yalnızca
`NULL` olanları toplar. Böylece:

- Geç gelen bir hareket sessizce kaybolmaz, sıradaki faturaya düşer.
- Hiçbir hareket iki faturada birden çıkamaz — **kurumsal müşteriyi çift borçlandırmak** bu
  özellikteki en ağır hatadır, bu yüzden şema seviyesinde imkânsız kılınmıştır.

Bağlama işlemi tek bir veritabanı işlemi içinde ve yalnızca `fleet_invoice_id IS NULL` olan
satırlar üzerinde yapılır; eş zamanlı iki istek gelse ikincisi hiçbir satır bağlayamaz ve
reddedilir.

### Ne faturalanır, ne faturalanmaz

| Hareket | Faturaya girer mi? |
| --- | --- |
| Yakıt alımı (`charge`) | Evet |
| İade (`refund`) | Evet — ait olduğu plakanın satırından düşülür |
| Bakiye yükleme / ödeme (`topup`) | **Hayır** — bu bir satış değil ödemedir; faturalanırsa müşteri ödediği para için ikinci kez borçlandırılır |
| Düzeltme (`adjustment`) | **Hayır** — elle yapılan bir düzeltmenin faturaya hangi kalem adıyla gireceği operatörün kararıdır; sessizce bir yakıt satırı uydurmak doğru olmaz |

Satırlar **plaka + yakıt tipi** bazında toplanır: 200 dolumlu bir ayda 200 satırlık fatura
kimsenin işine yaramaz, müşterinin istediği kırılım "hangi araç, hangi yakıttan ne kadar".
Dolum dökümü zaten portalın ekstresinde ve CSV'sinde durur.

### Rakamlar neden satırlardan türetiliyor?

Fatura başlığındaki KDV hariç tutar, satırların KDV hariç tutarlarının **toplamıdır** —
bağımsız hesaplanmaz. Bağımsız hesaplansaydı satır başına yuvarlama ile başlık arasında 1
kuruşluk fark oluşabilirdi (ör. 0,01 + 0,03 TL'lik iki satır: satırlar 0,04, başlık 0,03) ve
GİB, kalemleri genel toplamıyla tutmayan bir belgeyi reddeder.

Tutarlar fatura kesildiği **anda dondurulur** (`fleet_invoices.lines_json` ve tutar
alanları). Sonradan gelen bir iade, imzalanmış bir faturanın rakamını geriye dönük
değiştiremez; o iade sıradaki faturaya düşer. Aynı gerekçe `fuel_tank_readings.book_liters`
ve gün sonu mutabakatının gün kapanışı için de geçerlidir.

### Gönderim başarısız olursa

Fatura kaydı `failed` olarak **kalır** ve hareketler ona bağlı kalır; personel aynı faturayı
"Yeniden Gönder" ile tekrar gönderir. Bağlantı geri alınsaydı, sağlayıcıya gerçekte ulaşmış
olan bir belge ikinci kez kesilebilirdi. Zaten gönderilmiş bir fatura tekrar gönderilemez.

### Teyit edilmesi gerekenler

- **İade faturası:** Halihazırda faturalanmış bir döneme ait bir iade, bu tasarımda sıradaki
  faturaya eksi kalem olarak düşer. Türkiye'de kesilmiş bir e-Faturanın düzeltilmesi için
  alıcının **iade faturası** kesmesi gerekebilir; hangi durumda hangisinin geçerli olduğu
  mali müşavirinizle teyit edilmelidir.
- **Bu ortamda canlı test edilemedi:** Uyumsoft'un sunucularına bu sandbox'tan erişilemiyor
  (bkz. aşağıdaki e-Fatura bölümündeki aynı not). İstek gövdesi ve akışın tamamı yerel bir
  taklit uçla uçtan uca doğrulandı; gerçek Uyumsoft hesabıyla **sizin tarafınızdan test
  edilmelidir** — özellikle kurumsal e-Fatura için `DeliveryType` ve
  `AccountingCustomerParty` alanlarının Uyumsoft'un güncel sözleşmesine uyduğu.

## Fiyat değişikliği güvenlik kontrolü (fat-finger koruması)

Fiyat güncellemesinin tek kontrolü *"pozitif ve 1000'den küçük"* idi. **54,20 yerine 5,42**
yazmak — bir ondalık kayması — bu kontrolden geçer. Personelsiz istasyonda bunu fark edecek
bir kasiyer yoktur: gece boyunca motorin maliyetin onda birine satılır. Ters yönde de aynı
derecede kötüdür; 542,00 yazılırsa müşteriler on kat fazla öder.

İki ayrı kontrol vardır ve **birbirinin yerine geçmez**:

| Kontrol | Ne yakalar |
| --- | --- |
| **Sapma** — mevcut fiyattan %20'den (ayarlanabilir) fazla uzaklaşma | Ondalık kayması, fazladan/eksik hane |
| **Maliyet altı** — yeni fiyat, o tankın ağırlıklı ortalama alış maliyetinin altında | Sapma küçük olsa bile zararına satış (maliyet yükselmişken fiyatın geride kalması) |

Bunlardan biri bile tetiklenirse istek **409** ile döner ve ekranda mevcut fiyat, yeni fiyat
ve değişim yüzdesi yan yana gösterilerek açık onay istenir. Onaylanırsa istek `force` ile
tekrarlanır ve denetim izine `forcedPastGuard: true` yazılır — *"bu fiyatı kim, uyarıya
rağmen mi girdi?"* sorusu sonradan aranır.

**Bu bir yasak değil, bir hız kesicidir.** Gerçek fiyat sıçramaları olur (ÖTV değişikliği,
kur şoku) ve sistemin *"olamaz"* demeye hakkı yoktur. Yapabileceği şey, olağandışı bir
değişikliği kullanıcıya **sayıyla** göstermektir; yanlışlıkla yazılan bir rakam ile bilerek
girilen bir rakam arasındaki farkı ancak insanın kendisi bilebilir. Eşik bilinçli olarak
gevşek tutulmuştur (%20): her küçük zamda onay istemek uyarıyı anlamsızlaştırır ve kullanıcı
gözü kapalı onaylamayı öğrenir.

**İleri tarihli fiyat değişikliği de aynı kontrolden geçer** — hatta orada daha kritiktir:
yanlış rakam gece yarısı devreye girer ve o saatte ekrana bakan kimse yoktur. Karşılaştırma
bugünkü fiyata göre yapılır; plan uygulanana kadar araya başka bir değişiklik girmiş olabilir
ama elde daha iyi bir referans yoktur ve ondalık kaymasını yakalamak için fazlasıyla yeterlidir.

Maliyet karşılaştırması yalnızca ortalama maliyet **biliniyorsa** yapılır: birim maliyeti
girilmemiş teslimatlar ortalamayı etkilemez, yani 0 *"bedava aldık"* değil *"bilmiyoruz"*
demektir.

## KVKK: saklama süresi ve otomatik imha

Silme/erişim talebi ekranı (Yönetim → KVKK Başvuruları) yalnızca **talep üzerine**
çalışıyordu. Oysa kanun, kişisel verinin *"işlendikleri amaç için gerekli olan süreden"*
uzun tutulmamasını da ister — kimse talep etmese bile. Bugün girilen bir plaka, hiçbir şey
yapılmazsa on yıl sonra da veritabanında durur.

### Gerilim: vergi saklamayı, KVKK silmeyi istiyor

Vergi mevzuatı (VUK/TTK) mali kaydın saklanmasını **zorunlu** kılar; KVKK kimliğin
silinmesini ister. İkisi çelişmez, çünkü istedikleri şey aynı şey değildir:

> **Parayı tut, kimliği düşür.**

Süresi dolan işlemin **tutarı, litresi, tarihi, yakıt tipi ve ödeme yöntemi olduğu gibi
kalır**; yalnızca kişisel tanımlayıcılar (plaka, makbuz e-postası/telefonu) kaldırılır.
Aynı yaklaşım talep üzerine silmede ve istasyon silmede de kullanılır.

### Dokunulmayanlar

| Veri | Neden korunur |
| --- | --- |
| Pencere içindeki işlemler | Henüz süresi dolmadı |
| **Filo hesabına bağlı plakalar** | Aktif bir ticari sözleşmeye bağlıdır — işleme amacı devam ediyordur. Sözleşme bitip plaka hesaptan çıkarılınca bir sonraki pencerede doğal olarak kapsama girer |
| Son dönemde hareketi olan sadakat hesapları | Müşteri hâlâ programın içinde |
| Zaten anonimleştirilmiş kayıtlar | İşlem tekrar tekrar aynı satırları saymasın |

**Atıl sadakat hesapları silinir** — puanı olsa bile. Kullanılmayan bir hesabın plakasını
tutmak, amacı kalmamış kişisel veri saklamaktır; aksi halde *"puanı var"* gerekçesiyle veri
sonsuza kadar tutulurdu.

İşlemlerin plakası anonimleştirildiğinde **sadakat hesabı etkilenmez** (ayrı tablodadır ve
kendi bakiyesini korur). Bu bilinçlidir: müşterinin puanı, iki yıl önceki bir dolumun
plakasının saklanmasına bağlı değildir.

### Ayarlar

Varsayılan **kapalıdır**: kişisel veriyi geri dönülemez şekilde silen bir sürecin, istasyon
kendi saklama politikasını belirlemeden kendiliğinden çalışmaya başlaması doğru olmaz.
Varsayılan süre **24 ay**; KVKK bir sayı vermez, süreyi veri sorumlusu kendi *saklama ve
imha politikasında* belirler. Alt sınır 6 aydır — yanlışlıkla girilen bir "1", geri
dönülemez bir veri kaybı olurdu.

Ekran, ayarı açmadan önce **kaç kaydın etkileneceğini gösterir**; geri dönülemez bir işlemi
önce göstermeden çalıştırmak doğru olmaz. Günde bir kez otomatik çalışır, "Şimdi Uygula" ile
elle de tetiklenebilir.

Her imha **denetim izine yazılır**: KVKK uyumu *"yapıyoruz"* demek değil, yaptığını
**gösterebilmektir** — imha işlemlerinin kayıt altına alınması zaten mevzuatın beklediği
şeydir. Silinecek bir şey yoksa kayıt yazılmaz; her turda boş bir satır yazmak denetim izini
kullanılamaz hale getirirdi.

## Kritik alarm yükseltme (cevapsız alarmın peşini bırakmama)

Kritik bir alarm oluştuğunda **bir kez** bildirim gönderiliyor ve sistem susuyordu. Gece
3'te telefon sessizdeyse, e-posta spam'e düştüyse ya da tek operatör uyuyorsa bir daha
konuşan olmuyordu. Personelsiz istasyonda önemli olan senaryo tam da budur: **gören
kimsenin olmadığı alarm, istasyonu yakan alarmdır.**

Üç aşama vardır:

| Aşama | Ne olur | Kim bilgilendirilir |
| --- | --- | --- |
| 0 | Alarm oluştuğu anda ilk bildirim | İstasyonun kendi admin/operatör kullanıcıları |
| 1 | Varsayılan **15 dakika** sonra hatırlatma | Aynı kişiler |
| 2 | Varsayılan **45 dakika** sonra yükseltme | Aynı kişiler **+ dağıtım şirketi yöneticisi + platform yöneticisi** |

Sonra **durur**. Sınırsız tekrar, insanların bildirim kanalını tamamen susturmasına yol
açar; o zaman özellik, çözmeye çalıştığı sorunun ta kendisine dönüşür.

### Yükseltme onaylanınca durur — çözülmesi beklenmez

`acknowledged` bir insanın alarmı **gördüğü ve ilgilendiği** anlamına gelir. Sahada arıza
gideren birini aramaya devam etmek, onu telefonu susturmaya iter ve bir dahaki gerçek
alarmı da kaçırır. Bu yüzden sayaç *onayda* durur, *çözümde* değil.

### Yangın/gaz alarmı için süre sabittir

Güvenlik sensöründen gelen otomatik acil durdurma (`emergency_stop`) için hatırlatma **3**,
yükseltme **10** dakikadır ve istasyon ayarıyla **değiştirilemez**. Bir yangın alarmının
yükseltme saatini 6 saate çekmek, işletmeye bırakılabilecek bir tercih değildir.

### Ayrıntılar

- **Sayaç alarmın oluşma anından işler**, son bildirimden değil: bildirim gecikmeli
  gönderilse bile (kuyruk birikmiş olabilir) yükseltme takvimi kaymaz.
- **Uzun süre fark edilmemiş alarm doğrudan 2. aşamaya geçer.** Sunucu kapalıyken 3 saat
  geçmişse önce hatırlatma gönderip bir tur daha beklemek zaman kaybıdır.
- **Yükseltmede istasyon ekibi listede kalır** — haberi almayı bıraktıkları için değil,
  cevap veremedikleri için yükseltiyoruz.
- **Aynı kişiye iki kez gönderilmez.** Tek kişilik bir işletmede aynı kişi hem istasyon
  ekibinde hem üst kademede olabilir; aynı alarm için iki mesaj güveni azaltır.
- **Yükseltme süresi hatırlatmadan uzun olmak zorundadır**, aksi halde alarm doğrudan üst
  kademeye zıplar ve istasyonun kendi ekibine haber verme şansı elinden alınır.
- Bildirimler **dayanıklı yazma kuyruğuna** yazılır (`writeQueueService.ts`): sunucu tam o
  anda çöksün ya da SMTP/SMS sağlayıcısı erişilemez olsun, bildirim sessizce kaybolmaz.
- Alarm Merkezi'nde her aktif alarmın yanında *"hatırlatma gönderildi"* / *"üst kademeye
  yükseltildi"* bilgisi ve zamanı görünür — operatörün *"haber verildi mi?"* sorusunun
  cevabı listede durmalıdır.

## Arayüz düzeni: menü grupları ve tipografi

### Menü: aynı işe ait sayfalar grup altında

Bölümler düz listelerdi; bir istasyon yöneticisi tek sütunda 20'ye yakın link
görüyordu ve aralarında hiçbir hiyerarşi yoktu — aranan sayfa her seferinde baştan
taranarak bulunuyordu. Sayfalar artık "Ayarlar"da olduğu gibi açılır gruplar
halinde (`AppLayout.tsx`):

| Bölüm | İçerik |
| --- | --- |
| Platform | Konsolide Rapor, Kiosk Filosu · **Kuruluşlar** (Dağıtım Şirketleri, İstasyonlar) · **Sistem** (Audit Log, Demo Sıfırla) |
| Günlük İşleyiş | Genel Bakış, Pompalar, İşlem Listesi, Alarm Merkezi, Raporlama · **Saha** (Harita, Vardiya, Destek) |
| İstasyon Yönetimi | Gün Sonu Mutabakatı · **Akaryakıt** · **Müşteri** · **Yetki ve Uyum** · **Ayarlar** |

**Alarm Merkezi bilerek grup dışında bırakıldı**: yangın/gaz alarmı bir tık arkasında
durmamalı. Gruplama yalnızca görünüm içindir; hangi rolün neyi göreceği menüde,
erişim izolasyonu ise sunucuda belirlenir (bkz. `middleware/tenantScope.ts`).

**Tüm gruplar kapalı başlar** — bulunduğunuz sayfayı içeren de dahil. Açık başlamak menüyü
her sayfada farklı yükseklikte gösteriyor, alttaki grupların yeri kayıyordu; kapalı menü her
zaman aynı, kısa ve okunur. Bulunduğunuz grup yine de başlıkta vurgulanır, yani kapalıyken de
nerede olduğunuzu görürsünüz.

### Tipografi: tek bir ölçek

`h1`–`h4` için **hiçbir kural yoktu**: her başlık tarayıcı varsayılanını (h2 1.5em,
h3 1.17em ve büyük üst marjlar) kullanıyordu. Bu yüzden 142 başlığın 59'u kendi
inline `style`'ıyla aynı varsayılanla tek tek dövüşüyor, hiçbiri diğeriyle aynı
görünmüyordu. Punto da 20 ayrı değer arasına dağılmıştı (0.68 / 0.7 / 0.72 / 0.75 /
0.76 / 0.78 / 0.8 / 0.82 …) — birbirinden 1px farklı iki boyut düzensiz görünür ama
sebebi anlaşılmaz.

Artık `styles.css` içinde tek bir merdiven var ve sayfalar boyut değil **rol** seçer:

| Değişken | Kullanım |
| --- | --- |
| `--fs-2xs` | rozet, pill, tablo başlığı |
| `--fs-xs` | meta bilgi, kart içi bölüm etiketi |
| `--fs-sm` | yardım metni |
| `--fs-md` | panel gövde metni (varsayılan) |
| `--fs-lg` | form girdisi |
| `--fs-xl` / `--fs-2xl` / `--fs-3xl` | h3 (kart başlığı) / h2 (sayfa başlığı) / h1 |
| `--fs-num` | büyük sayı (istatistik kutusu) |

Başlıkların **üst marjı yoktur** (kutusunun üstüne yaslanır, alt boşluk sabittir);
bir başlıktan önce içerik varsa aralığı `* + h2/h3/h4` kuralı verir. Bu, 29 adet
`style={{ marginTop: 0 }}` yamasını gereksiz kıldı ve hepsi kaldırıldı.

Kiosk (dokunmatik, ayakta okunan) ve yazıcı çıktısı bu ölçeğin dışındadır — panel
puntosu onlara küçük gelir.

Kenar çubuğundaki bölüm başlıkları (Günlük İşleyiş / İstasyon Yönetimi) küçük
büyük-harf etiket değil, **gerçek başlıktır**: `--fs-lg`, tam metin rengi, üstünde
bir ayraç çizgisi. Belirginliği iki ayrı kanaldan alır — punto ve renk başlığı
okutur, çizgi bölümün nerede bittiğini gösterir. Renk vurgu (`--accent`) için
harcanmaz: panelde mavi "tıklanabilir" demektir, bölüm başlıkları ise tıklanamaz.
Hem yazı hem çizgi rengi tema değişkeninden geldiği için gündüz temasında
kendiliğinden döner.

### Onay kutuları

Onay/seçim kutuları genel `input` kuralının kurbanıydı: `width: 100%` ve `0.6rem`
dolgu alıp satırı boydan boya kaplayan biçimsiz beyaz bir kutuya dönüşüyorlardı.
Sayfalar bunu tek tek `style={{ width: "auto" }}` ile yamıyor, yamamayanlar bozuk
görünüyordu. Artık `input[type="checkbox"]` bir kez doğru tanımlı ve kutu + metin
için `.check` yardımcı sınıfı var. Aç/kapa **ayarları** ise ham onay kutusu değil
`StatusToggle` anahtarını kullanır.


## Kiosk'un bağlı olduğu pompa (pompa seçme adımının atlanması)

Bir istasyonda genelde tek değil, **pompa/ada başına ayrı bir fiziksel kiosk** bulunur. Kiosk
tek bir pompanın başında duruyorsa müşteriye *"hangi pompadasınız?"* diye sormak hem gereksiz
bir adım hem de yanlış pompayı seçip **başka bir müşterinin dolumunu başlatmasına** açık kapıdır.

Yönetim panelinde İstasyonlar → (istasyon) → **Kiosk Bilgisayarları** altında her kiosk kaydına
bir **bağlı pompa** seçilebilir (`station_kiosks.pump_id`). Bağlıysa:

- Kiosk açılış ucu (`GET /api/kiosk/station/:code`) `boundPumpId` döner,
- müşteri plakayı girer girmez o pompa otomatik seçilir ve doğrudan yakıt tipi adımına geçilir,
- adım çubuğundan da pompa adımı çıkarılır (görülmeyecek bir adımın işareti beklenmez).

Bağlı pompa **arızalı veya meşgulse otomatik seçim yapılmaz**: müşteriyi kullanılamaz bir
pompaya sessizce kilitlemek onu çıkışsız bırakırdı. O durumda seçim adımı eskisi gibi gösterilir
ve müşteri komşu pompayı seçebilir. Bağlı pompası olmayan kiosk (ör. ortak bir ödeme noktası)
eskisi gibi çalışır.

Pompanın **aynı istasyona ait olduğu** sunucuda doğrulanır — aksi halde bir kiosk başka bir
istasyonun pompasını müşteriye hiç sormadan seçebilirdi.

> **Ayar cihaz başınadır.** Sunucu hangi kiosk olduğunu ancak **cihaz tokeninden** anlar. Kiosk
> sade `/kiosk/KOD` adresiyle açılırsa `boundPumpId` null döner ve pompa seçme adımı çıkmaya
> devam eder — ayar yapılmış olsa bile. Kiosk'un, o kaydın **kurulum adresiyle**
> (`/kiosk/KOD?device=<token>`, panelde "Kurulum adresi" düğmesi) bir kez açılmış olması gerekir.
> Panel bunu hem alanın altında yazar hem de pompası bağlı ama hiç bağlanmamış kiosk kaydına
> *"kurulum adresi uygulanmadı"* rozeti koyar.

## Makbuz (e-posta / SMS / PDF)

İki sorun düzeltildi:

- **Tutar.** Makbuz `total_amount` (yakıt değeri) yazıyordu; indirim kodu veya puan kullanan
  bir müşteri **ödediğinden fazla** bir tutar yazan makbuz alıyordu. Artık "Ödenen Tutar"
  müşteriden gerçekten tahsil edilen nettir (`total − indirim`, negatife düşmez). İndirim
  varsa ayrıca "Ara Toplam" ve "İndirim / Puan" satırları gösterilir; indirim yoksa bu satırlar
  hiç çıkmaz — tek kalemlik bir makbuzda aynı rakamı iki kez yazmak kafa karıştırır.
- **"Bu bir sanal ödeme makbuzudur."** Simüle ödeme kaldırıldıktan sonra her ödeme gerçek
  (iyzico veya filo hesabı). Müşteriye "sanal" diyen bir makbuz hem yanlış hem de bir
  uyuşmazlıkta aleyhte delil olurdu. Metin *"Bu belge bilgi amaçlı bir ödeme makbuzudur;
  mali belge yerine geçmez."* ile değiştirildi (e-posta, SMS ve PDF'te aynı).

Makbuza ayrıca ödeme yöntemi ve (tanımlıysa) istasyon telefonu eklendi. Metin ve HTML
sürümleri artık **tek kaynaktan** (`buildReceiptRows`) üretiliyor, birbirinden ayrışamazlar.

## Otomatik e-Fatura

Fatura yalnızca panelde "E-Fatura Oluştur" düğmesine basıldığında kesiliyordu. Personelsiz bir
istasyonda o düğmeye basacak kimse yok: fatura, birinin gün içinde işlem listesini açıp tek tek
tıklamasına kalıyordu — yani pratikte hiç kesilmiyordu. Fatura kesmek yasal bir yükümlülük, bir
panel eylemi değil.

Artık satış tamamlanır tamamlanmaz (normal bitiş ve acil durdurma yollarının ikisinde de)
`invoiceAutoService.ts` arka planda e-Arşiv faturayı keser. Kurallar:

- Entegrasyon kurulmamış istasyonda sessizce geçilir (hata değil, "bu istasyon e-belge kullanmıyor").
- Hiçbir şey tahsil edilmemiş işlem (0 litre ile kapanan) için fatura kesilmez.
- Aynı işlem için daha önce başarılı fatura kesildiyse tekrar kesilmez.
- **Hiçbir koşulda hata fırlatmaz:** sağlayıcıya ulaşılamaması biten bir satışın akışını bozmamalı —
  müşteri yakıtını almış, pompa serbest kalmış olmalı.
- Başarısız kesim `failed` olarak kaydedilir; paneldeki düğme artık bir "oluştur" değil
  **yeniden deneme** yoludur ve metni de bunu söyler.
- Otomatik kesimde `created_by` NULL kalır: o anda ekranın başında kimse yok, uydurma bir
  kullanıcı yazmak denetim izini yanlışlaştırırdı.

**E-İrsaliye otomatik değildir ve bilinçli olarak öyle bırakılmıştır.** İrsaliye bir *satışın*
değil bir *mal hareketinin* belgesidir; yakıt teslimatı zaten panele elle girilir ve belgenin ne
zaman kesileceği (kabul farkı ölçüldükten önce mi sonra mı) mevzuata bağlı bir karardır. Düğme
bu yüzden teslimat kaydının yanında durur.

## Rapor merkezi

Raporlar sisteme dağılmıştı: ciro Raporlama'da, tedarikçi özeti stok sayfasında, sapma başka
sayfada, gün sonu bir başkasında. *"Geçen ay ne oldu?"* sorusunu cevaplamak için dört ayrı sayfa
gezmek gerekiyordu. Hepsi tek sayfada, **tek bir tarih aralığı** altında toplandı:

| Sekme | İçerik |
| --- | --- |
| Satış | Ciro/indirim/litre özeti, yakıt tipine göre kâr, pompa performansı, günlük ciro, yoğun saatler, ödeme yöntemi |
| İade | İade tutarı/adedi, iadenin gittiği yer (ödeme yöntemi), iade kayıtları |
| Gün Sonu | Kapatılmış günler, beklenen/sayılan/fark, CSV |
| Yakıt ve Tedarik | Tedarikçi özeti, teslimat kabul farkı, yakıt sapması |

Sekme değiştirince aralık korunur — aynı dönemin farklı yüzlerine bakmak için filtreyi baştan
kurmak gerekmez. Bitiş günü aralığa **dahildir** (gün sonuna kadar uzatılır); aksi halde o günün
tüm satışları rapordan düşerdi. Pompa süzgeci JOIN koşulundadır: WHERE'e konsaydı o aralıkta
satış yapmamış pompalar listeden tamamen düşüp "0 satış" bilgisi kaybolurdu.

Ciro/kâr raporları **operatöre kapalıdır** (bkz. Roller).

## Roller: ciro işletmenin, destek talebi sahanın

- **Operatör** pompaları, işlem listesini, alarmları, istasyon haritasını, vardiyayı ve
  **destek taleplerini** görür. Müşteri pompada takıldığında ona ilk ulaşan kişi odur.
- **Ciro/kâr raporları** (Raporlama sayfası, Genel Bakış'taki ciro kartları) istasyon
  sahibinindir. Bu ayrım sunucuda uygulanır (`routes/reports.ts`); panelde kartların gizlenmesi
  tek başına yeterli olmazdı.
- **Dağıtım şirketi yöneticisi** (`tenant_admin`) personelle **aynı adresten** (`/giris`) girer;
  panelde yalnızca kendi şirketine atanmış istasyonları, konsolide raporu ve kiosk filosunu görür.
  Hesabı platform yöneticisi, Kullanıcılar → Yeni Kullanıcı ekranından "Dağıtım Şirketi
  Yöneticisi" rolünü seçip şirketi işaretleyerek açar.
- **Filo müşterisi** panele hiç girmez; kendi portalı `/filo` adresindedir (bkz. ilgili bölüm).

## Denetim kaydı: kim, nereden

Kullanıcı adı NULL kalabiliyordu: personel oturumu olmayan her işlem (filo portalı müşterisi,
zamanlanmış iş, başarısız giriş denemesi) logda kimliksiz görünüyordu — denetim günlüğünün tek
işi buydu. Artık her kaydın bir **aktörü** var:

| `actor_type` | Anlamı | `username` alanı |
| --- | --- | --- |
| `staff` | Panelden giriş yapmış personel | kullanıcı adı |
| `fleet_portal` | Filo portalı müşterisi | portal e-postası |
| `system` | Zamanlanmış iş (fiyat, KVKK imha, otomatik faturalama) | işin adı |
| `anonymous` | Henüz kimliği doğrulanmamış (başarısız giriş) | denenen kullanıcı adı |

Ayrıca:

- **Rol kaydın içine yazılır**: bir kullanıcının rolü sonradan değiştiğinde geçmiş kayıtların
  "o an hangi yetkiyle yapıldığı" bilgisi değişmemeli.
- **IP ve tarayıcı imzası** artık isteğin başında bir kez yakalanıp `AsyncLocalStorage` ile
  taşınır (`middleware/requestContext.ts`). 100'den fazla `recordAudit` çağrısı bunları elle
  taşımak zorundaydı; unutulan yerde kayıt "IP yok" olarak düşüyordu.
- **Detay sütununda boş değer gösterilmez.** Uygulanmamış süzgeçler `{"action":null,"userId":null}`
  olarak yazılıyor ve logu okuyan kişiye "veri eksik" izlenimi veriyordu; oysa anlamı sadece
  "süzgeç kullanılmadı" idi. Artık yeni kayıtlara hiç yazılmıyor, eski kayıtlarda da ekranda
  gizleniyor — detay ham JSON yerine okunur "anahtar değer" çiftleri olarak gösteriliyor.

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

## Gerçek e-Fatura/e-Arşiv altyapısı: Uyumsoft

Sadakat puanı ve kampanya kodu sistemlerinin yanı sıra, tamamlanan işlemler için **gerçek bir
e-Fatura/e-Arşiv entegrasyon altyapısı** da hazırdır. Bu da iyzico gibi demo/simülasyon
değildir: `server/src/services/invoiceService.ts`, Uyumsoft'un dokümante edilmiş REST
entegrasyon API'sine (`BasicIntegrationApi`, `Action: "SendInvoice"`) göre yazılmış gerçek
istemci kodudur ve UBL-TR standardına uygun tam bir fatura gövdesi (`AccountingSupplierParty`,
`InvoiceLine`, `LegalMonetaryTotal` vb.) oluşturup gönderir.

- **Yapılandırma istasyon bazlıdır:** Yönetici Paneli → Ayarlar → "Fatura Ayarları (E-Fatura /
  e-Arşiv)" ekranından her istasyon kendi Uyumsoft müşteri hesabının kullanıcı adı/şifresini,
  ortamını (sandbox/production) ve şirket vergi bilgilerini (VKN, unvan, vergi dairesi, adres)
  girer. Şifre veritabanında saklanır, API üzerinden yalnızca maskeli (son 4 hane) döner.
- **Hazır olmadan çalışmaz, çökmez:** Bu bilgiler eksikken (varsayılan durum) `isInvoiceReady()`
  kontrolü `false` döner ve `POST /api/transactions/:id/invoice` net bir Türkçe hata mesajıyla
  (`409`) reddedilir — gerçek bir Uyumsoft hesabı bağlanana kadar sistem bu haliyle güvenle
  devrede kalabilir.
- **Akış:** Operatör panelindeki İşlem Listesi'nde, `completed` durumundaki her işlem satırında
  bir "E-Fatura Oluştur" düğmesi bulunur. Tıklandığında sunucu Uyumsoft'a gerçek bir HTTP isteği
  atar; başarılı olursa dönen `InvoiceId` yerel `invoices` tablosuna kaydedilir ve düğme
  "Kesildi" rozetine döner, başarısız olursa hata mesajı (ör. kimlik doğrulama hatası, ağ hatası)
  aynı satırda gösterilir ve tekrar denenebilir.
- **Müşteri kimliği:** Kiosk'ta alıcı kimlik bilgisi toplanmadığından, Türkiye'de akaryakıt
  istasyonlarında yaygın olan **"Nihai Tüketici"** (VKN/TCKN'siz perakende e-Arşiv) olarak
  kesilir; plaka, açıklama alanında referans olarak yer alır.
- **Bu ortamda canlı test edilemedi:** Uyumsoft'un test (sandbox) sunucusuna gerçek bir HTTP
  isteği atıldığı ve sahte kimlik bilgileriyle sunucudan gerçek bir HTTP 403 yanıtı alındığı bu
  oturumda doğrulandı (bağlantı gerçekten kuruluyor, hata düzgün şekilde 502'ye çevrilip
  sunucu çökmüyor) — ancak gerçek bir Uyumsoft müşteri hesabıyla uçtan uca başarılı fatura
  kesimi **sizin tarafınızdan test edilmelidir**. KDV oranı kodda %20 olarak sabitlenmiştir
  (`invoiceService.ts` içindeki `VAT_RATE`); oran değişirse orası güncellenmelidir.

## Gerçek e-İrsaliye altyapısı: Uyumsoft (yakıt teslimatları için)

e-Fatura ile aynı Uyumsoft hesabı (Ayarlar → "Fatura / İrsaliye Ayarları"), istasyona gelen
yakıt teslimatları (tanker sevkiyatları) için de gerçek bir **e-İrsaliye** (UBL-TR
`DespatchAdvice`) oluşturmak üzere kullanılır. `server/src/services/waybillService.ts`,
Uyumsoft'un aynı `BasicIntegrationApi`'sini `Action: "SendDespatchAdvice"` ile çağırır ve
OASIS UBL 2.1 `DespatchAdvice` örneğine göre yapılandırılmış (`DespatchSupplierParty`,
`DeliveryCustomerParty`, `Shipment`/`Delivery`, `DespatchLine`/`DeliveredQuantity`) bir
belge gövdesi gönderir — bu da simülasyon değildir.

- **Nereden tetiklenir:** Operatör panelinde Yakıt Stoku sayfasındaki Stok Hareketleri
  tablosunda, yalnızca `delivery` (teslimat) tipi satırlarda bir "E-İrsaliye Oluştur"
  düğmesi bulunur. Teslimat kaydedilirken zaten girilen tedarikçi adı ve irsaliye/fiş
  numarası (`fuel_stock_movements.supplier` / `delivery_ref`) belge içeriğine taşınır.
- **Ayrı bir ayar ekranı yoktur:** e-Fatura ile tamamen aynı Uyumsoft kullanıcı adı/şifresi
  ve şirket vergi bilgileri kullanılır (`invoiceSettingsService.ts` — `isInvoiceReady()`
  her iki belge türü için de aynı hazırlık kontrolünü yapar); bu bilgiler eksikken
  `POST /api/fuel-stock/movements/:id/waybill` net bir Türkçe hata mesajıyla (`409`) reddedilir.
- **Gerçek dünya notu:** Türkiye'de e-İrsaliye'yi genelde malı sevk eden taraf (tedarikçi/
  taşıyıcı) düzenler; burada istasyon, kendi kayıtlarında (isteğe bağlı) resmi bir teslim
  alma belgesi oluşturmak için kendi Uyumsoft hesabından bu belgeyi üretir.
- **Bu ortamda canlı test edilemedi:** e-Fatura'da olduğu gibi, sahte kimlik bilgileriyle
  Uyumsoft'un test sunucusuna gerçek bir istek atılıp gerçek bir HTTP 403 yanıtı alındığı
  (düzgün şekilde 502'ye çevrilip sunucu çökmediği) ve hazır-olmama (409) red yolunun
  doğru çalıştığı doğrulandı — gerçek bir Uyumsoft hesabıyla uçtan uca başarılı irsaliye
  kesimi sizin tarafınızdan test edilmelidir.

## Simülasyon olarak uygulanan bileşenler (donanım gerektirdiği için / iyzico yapılandırılmadığında)

1. **LPR / plaka tanıma:** Gerçek bir kamera donanımı olmadığından, `POST /api/kiosk/lpr/recognize`
   plaka formatını (il kodu 01–81 + harf/rakam düzeni) doğrulayan ve bir güven skoru üreten
   gerçekçi bir kural motoruyla çalışır. Kiosk arayüzünde bu açıkça belirtilir; kullanıcı
   isterse plakayı elle de girebilir.

**Kaldırılan simülasyon: sanal ödeme.** iyzico yapılandırılmamış istasyonlarda kiosk daha
önce sahte bir kart formu gösterip ödemeyi "onaylanmış" sayıyordu. Gerçek bir istasyonda bu,
parası tahsil edilmeden yakıt veren bir pompa demektir; bu yol tamamen kaldırıldı. Kart
ödemesi yapılandırılmamışsa kiosk açık bir *"Kart ödemesi şu an alınamıyor"* ekranı gösterir
ve işlem orada durur. Aynı gerekçeyle demo veri sıfırlama aracı da kaldırıldı.

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

Giriş ekranındaki **"Şifremi unuttum"** akışı (`passwordResetService.ts`) da aynı `sendEmail`/
`sendSms` fonksiyonlarını kullanır: kullanıcının hesabına kayıtlı e-posta/telefon varsa tek
kullanımlık, 30 dakika geçerli bir bağlantı gönderilir (bağ veritabanında yalnızca SHA-256
özeti olarak saklanır, ham token hiçbir yerde tutulmaz). SMTP/SMS yapılandırılmamışsa bağlantı
oluşturulur ama teslim edilemez — bu durumda hesabı olan bir yönetici, Kullanıcı Yönetimi
sayfasındaki "Şifre Sıfırla" ile elle bir geçici şifre atayabilir.

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

Kiosk ekranı: `http://localhost:5173/kiosk/STM1234` (istasyonun **kodu**; `seed` çıktısında yazar).
Eski `/kiosk/<slug>` adresleri de çalışmaya devam eder.
Personel girişi: `http://localhost:5173/giris`


## Kiosk cihaz doğrulaması (kiosk uçlarının güvenliği)

Kiosk API'si müşteriden giriş istemez; bu nedenle adresi gizlemek tek başına koruma
sağlamaz — işlem başlatan uç yalnızca bir `pumpId` aldığı için, adres bilinmese bile
dışarıdan pompa rezerve edilebilirdi. Koruma **cihaz doğrulaması** ile sağlanır:

- Her fiziksel kiosk (Yönetim → İstasyonlar → *Kiosk Bilgisayarları*) kendi
  **cihaz tokeni** ile oluşturulur.
- Kiosk PC'sinde ekran **bir kez** `“Kurulum adresi”` butonundaki adresle açılır:
  `/kiosk/STM1234?device=<token>`. Token tarayıcıya kaydedilir, adres çubuğundan
  temizlenir; sonraki açılışlarda sade adres (`/kiosk/STM1234`) yeterlidir.
- Sunucu, tokeni olan isteği o kiosk'un **istasyonuna sabitler**: başka bir istasyonun
  pompası kullanılamaz (403).
- İstasyon kartındaki **“Kiosk cihaz tokeni zorunlu”** anahtarı bu zorunluluğu açar.
  Yeni istasyonlarda **açık** gelir. Bu özellikten önce kurulmuş istasyonlarda,
  kiosk'lar aniden çalışmaz hale gelmesin diye **kapalı** başlar; tokenleri
  dağıttıktan sonra buradan açın.

> `STM1234` kodu bir **sır değildir** (kısa ve tahmin edilebilir). Okunabilir/benzersiz
> bir tanımlayıcıdır: destek, envanter ve istasyon adı değişse de sabit kalan adres
> içindir. Güvenliği sağlayan şey cihaz tokenidir.

## Kiosk yardım/destek çağrısı

Personelsiz istasyonda kartı çekilip yakıt akmayan ya da tabancayı çalıştıramayan bir
müşterinin başka hiçbir yolu yoktu: ekranın ona söylediği tek şey *"istasyon
yöneticinizle iletişime geçin"* idi — personeli olmayan bir istasyonda.

Kiosk ekranının altındaki **Yardım / Destek** butonu (her adımda erişilebilir) bir talep
açar. Müşteri sorun kategorisini seçer, isterse kısa bir not ve geri arama telefonu
bırakır; içinde bulunduğu **pompa ve işlem talebe otomatik iliştirilir**.

Talep **kritik alarma** çevrilir. Bu bilinçli: mevcut kritik alarm bildirim zinciri
(e-posta/SMS, dayanıklı yazma kuyruğu üzerinden) hiçbir ek iş yapılmadan devreye girer.
Panelde **Destek Talepleri** sayfasından takip edilir; talep kapatıldığında bağlı alarm
da otomatik çözülür — ikisi ayrı kalırsa alarm merkezi kirli birikirdi. Sayfa **operatöre de
açıktır** (sahada çalışan kişi odur). Kapatılmış talepler de görülebildiği için liste yüzlerce
satıra ulaşabilir: liste tek satırdır, detay ve kapatma formu satıra tıklanınca açılan
penceredir (İstasyonlar sayfasındaki desen).

Talep gönderildikten sonra ekranda müşteriye **istasyonun kendi telefonu** gösterilir
(`stations.contact_phone`, İstasyonlar sayfasından girilir). Önceden burada *"acil bir durum
varsa 112'yi arayın"* yazıyordu: yakıt akmayan bir pompa acil servis vakası değildir, müşteriyi
oraya yönlendirmek hem onu yanlış yere gönderir hem de acil hattı gereksiz meşgul eder. İşletme
numarası tanımlı değilse **hiçbir numara gösterilmez** — yanlış numara, numarasızlıktan kötüdür.

### İki koruma

- **Cihaz tokeni zorunlu.** Aksi halde bu uç, istasyon kimliğini bilen herkesin nöbetçi
  personele SMS yağdırabileceği bir kanala dönüşürdü.
- **Alarm susturma penceresi (10 dk).** Paniğe kapılan bir müşteri butona üst üste
  basabilir; her basış ayrı bir SMS gönderirse bildirim zinciri işe yaramaz hale gelir.
  Talepler yine de kaydedilir, yalnızca alarm tekrarlanmaz. Farklı kiosk'lar birbirini
  susturmaz.

## Gün sonu kasa/ödeme mutabakatı

**Gün Sonu Mutabakatı** ekranı (İstasyon Yönetimi menüsü), sistemin kaydına göre tahsil
edilmiş olması gereken tutarı banka/POS ekstresine **gerçekten** geçen tutarla
karşılaştırır. Yakıt sapmasıyla aynı mantık: orada kayıt stoğu fiziksel ölçümle,
burada kayıt tahsilatı parayla sınanır.

Gerçekleşen tutar **elle** girilir. Bu bilinçli bir sınır: iyzico'nun hakediş/ekstre
raporunu çekecek bir ucu yok (`iyzicoService.ts` yalnızca checkout, capture ve iptal
sağlar), ve zaten mutabakatın anlamı sistem dışı bir kaynağı sisteme karşı doğrulamaktır —
sayıyı sistemin kendisi üretirse mutabakat yapılmış olmaz.

### İş günü Türkiye saatiyle başlar

İşlem zaman damgaları UTC'dir. UTC tarihine göre gruplamak günü yerel saatle **03:00'te**
bölerdi: gece 01:30'daki bir satış bir önceki günün kasasına yazılır, kasayı kapatan kişi
ekstresiyle tutmayan bir rakam görürdü. Bu yüzden mutabakat, iş gününü UTC+3 ofsetiyle
hesaplar (Türkiye 2016'dan beri yıl boyu UTC+3, yaz saati uygulaması yok).

> Not: Raporlama sayfasındaki günlük ciro grafiği hâlâ UTC tarihine göre grupluyor
> (`reports.ts`). Trend grafiği için bu küçük bir kayma, mutabakat için ise kabul edilemezdi.

### Askıda kalan işlemler

Ekstre ile kayıt arasındaki farkın kaynağı genelde şunlardır ve ayrı bir listede gösterilir:

- **Parası bloke, işi bitmemiş** (`authorized`/`processing` ama tamamlanmamış): müşteri ödedi, yakıt akmadı.
- **Tahsilatı başarısız veya iade edilmiş** (`failed`/`refunded`): ekstredeki tutarı doğrudan etkiler.

O gün **kesilen** iadeler beklenen tutardan **düşülür** — geri gönderilen para kasada
olamaz. Karta yapılan iadenin hesaba yansıması sağlayıcıya göre gecikebileceğinden,
düşülen tutar ayrıca raporlanır: ekstre henüz brüt görünüyorsa operatör farkın sebebini
aynı ekranda görür ve bu fark kalıcı değil zamanlama kaynaklıdır.

### Kapanış fotoğraftır

Gün kapatıldığında o anki kırılım JSON olarak saklanır. Sonradan gelen bir iade veya
düzeltme, yeniden hesaplanan bir rakamı değiştirirdi ve kapatılmış gün imzalanan rakamla
artık tutmazdı. Aynı gün iki kez kapatılamaz; henüz gelmemiş bir günün kasası kapatılamaz.

## İade (refund)

**İşlem Listesi** ekranında, tamamlanmış her işlemin satırında bir **İade** düğmesi vardır
(yalnızca yönetici rolleri; operatör/görüntüleyici iade yapamaz). Açılan pencere ne kadarın
iade edilebilir olduğunu gösterir, kısmi tutar girilmesine izin verir ve gerekçe ister.

Bu özellik gelmeden önce sistemde para iade etmenin **hiçbir yolu yoktu**: tahsil edilmiş
bir ödeme yalnızca iyzico panelinden elle iade edilebiliyor, sistemde izi kalmıyordu. Gün
sonu kasası geri gönderilen parayı ciroda saymaya devam ediyor, denetim izinde hiçbir şey
görünmüyordu. Personelsiz istasyonda bu boşluk daha da ağırdır: "ödedim ama yakıt akmadı"
diyen müşteriye yerinde çözüm üretecek bir görevli yoktur; tek çözüm sistemin kendisidir.

### İade bir bayrak değil, kendi başına bir olaydır

İade kayıtları ayrı bir `refunds` tablosunda tutulur, işlem üzerinde bir durum değeri
olarak değil. Kısmi iade ancak böyle ifade edilebilir — ve iadenin **kesildiği** güne
yazılması da. `payment_status` yalnızca tamamı iade edildiğinde `refunded` olur; kısmi
iadede işlem hâlâ tahsil edilmiş durumdadır ve farkı `refunds` tablosu taşır.

> Bu değişiklik iki sessiz hatayı da kapattı: mutabakat `payment_status = 'refunded'`
> okuyordu ama o değeri **yazan hiçbir kod yoktu** (iade satırı hiçbir zaman sıfırdan
> farklı olamıyordu), ve beklenen tutardan iade **düşülmüyordu** — yani ilk iade
> yapıldığı anda kasa sessizce sapacaktı.

### İade, işlemin gününe değil kesildiği güne yazılır

Geçen aya ait bir işlem için bugün kesilen iade **bugünün** kasasından çıkar. Kapanmış bir
günün rakamını geriye dönük değiştirmek, imzalanmış bir mutabakatı bozmak demek olurdu
(aynı gerekçe: filo icmal faturası satırları, tank defter stoğu fotoğrafı).

### Yalnızca tahsil edilmiş para iade edilebilir

Ödemesi alınmamış (`authorized`/`processing`) bir işlemde iade değil **iptal** gerekir —
blokaj bankada zaten kendiliğinden serbest kalır. Kısmi iadeler birikerek tahsil edilen
tutarı aşamaz.

### Ödeme yöntemine göre yönlendirme

| Yöntem | Ne olur |
| --- | --- |
| `iyzico` | Gerçek iade çağrısı; para karta döner, yanıt imzası doğrulanır |
| `fleet` | Filo hesabına geri yüklenir (mevcut `refundCharge` yolundan, bakiye ile hareket defteri ayrılmasın diye) |
| diğer | Sanal POS simülasyonu; kayıt yeterlidir |

Sağlayıcı çağrısı **başarısız** olursa kayıt `failed` olarak düşer ve işlem
**değiştirilmez**: para hâlâ müşteride değildir, "iade edildi" demek yanlış olurdu.
Başarısız deneme yine de kaydedilir — "iade denendi mi?" sorusunun cevabı, müşteri tekrar
aradığında aranan ilk şeydir — ama kalan iade edilebilir tutarı tüketmez.

### Sadakat puanı orantılı geri alınır

İade edilen bir dolumdan puan kazanılmış kalması, müşteriye iki kez ödeme yapmak olurdu.
Kısmi iadede puan orantılı düşülür. Bakiye yetmiyorsa (puan harcanmış olabilir) sıfıra
çekilir — eksiye düşürmek, müşteriyi bir sonraki alışverişinde borçlandırmak demek olurdu.
Puan geri alınamazsa iade **yine de geçerlidir**; durum loglanır, elle düzeltilebilir.

Her iade denetim iznine (`transaction_refunded`) tutar, gerekçe ve ödeme yöntemiyle
birlikte işlenir. İade toplamı işlem listesi ucuyla birlikte gelir ve CSV dökümünde
`refunded_amount` sütunu olarak yer alır — ciro dökümü iadeleri göstermezse mutabakatla
çelişir ve fark açıklanamaz görünür.

## Kiosk filosu (çok istasyonlu sağlık izleme)

**Kiosk Filosu** ekranı (Platform menüsü, yalnızca platform yöneticisi) tüm istasyonlardaki
fiziksel kiosk bilgisayarlarını tek listede gösterir: durum, son bağlantı, AnyDesk ID ve
istasyonundaki açık donanım arızaları. Duruma göre filtrelenebilir; kiosk adı, istasyon adı,
istasyon kodu veya AnyDesk ID ile aranabilir.

### Kalp atışı neden gerekli?

Kiosk ekranı API'yi normalde **yalnızca bir müşteri kullanırken** çağırır. Bu yüzden gece
boyu müşteri gelmeyen bir istasyonun sapasağlam kiosk'u "ölü" görünürdü. Kiosk artık
`POST /api/kiosk/heartbeat` ucunu dakikada bir çağırır (cihaz tokeniyle); böylece
*"kimse kullanmıyor"* ile *"cihaz düşmüş"* birbirinden ayrışır.

| Durum | Anlamı |
| --- | --- |
| Çevrimiçi | Son 10 dakika içinde kalp atışı geldi |
| Çevrimdışı | 10 dakikadan uzun süredir sinyal yok — **uyarı alarmı açılır** |
| Kurulum bekliyor | Kayıt açıldı, kurulum adresi henüz cihaza uygulanmadı (arıza değildir) |

Çevrimdışı kalan kiosk için `kiosk_offline` uyarı alarmı açılır, kiosk geri dönünce alarm
kendiliğinden kapanır. Pasif istasyonların kiosk'ları için alarm üretilmez — kapalı olmaları
zaten beklenen durumdur.

### Ekran gözcüsü: ödeme adımında takılı kalan kiosk

Kiosk'ta bir boşta-kalma sayacı vardır (60 sn sonra uyarı, 20 sn sonra karşılama ekranına
dönüş), ancak **ödeme adımında bilinçli olarak kapalıdır**: iyzico ödeme formu çapraz
kaynaklı bir çerçeve içinde açılır, müşteri kart bilgisini yazarken bizim pencerede hiçbir
fare/klavye olayı oluşmaz — sayaç açık olsa müşteriyi kartını yazarken dışarı atardı.

Bunun bedeli şuydu: ödeme formunu açıp vazgeçen bir müşteriden sonra ekran o formda takılı
kalıyordu; sıradaki müşteri, öncekinin yarım kalmış ödeme ekranıyla karşılaşıyordu.

Kiosk artık ödeme adımında işlemin durumunu **5 saniyede bir** sorgular ve sunucu işlemi
`cancelled`/`failed` olarak kapattığı anda ekranı karşılama ekranına döndürür. Bu, kiosk
tarafında **ayrı bir zamanlayıcı değildir**: paranın tarafı zaten sunucuda çözülüyor —
ödemesi tamamlanmayan işlemler 3 dakika sonra iptal edilir, pompa serbest bırakılır, rezerve
puan/indirim kodu iade edilir ve geç gelen ödemeye karşı bir güvenlik ağı çalışır
(`reconcileStaleCreatedTransactions`). Kiosk'ta ikinci bir süre tanımlamak, iki tarafın
farklı anlara karar vermesi demek olurdu; onun yerine ekran sunucunun kararını izler.

**Kapsam dışında kalan tek durum:** iyzico ödeme sayfasına tam sayfa yönlendirme yapıldığında
(`paymentPageUrl`) tarayıcı uygulamamızdan tamamen çıkar; o noktada çalışan bir JavaScript'imiz
kalmadığı için ekranı geri getirmek yalnızca kiosk modundaki tarayıcı yapılandırmasıyla
(ör. Chrome kiosk modu + zaman aşımında ana sayfaya dönüş) mümkündür. Müşteri kendi
dönerse akış kaldığı yerden devam eder: işlem kimliği ve erişim token'ı `sessionStorage`'a
yazıldığı için sayfa geri geldiğinde doğru adıma otomatik olarak konumlanır.

## Yakıt sapma (kaçak/kayıp) takibi

Personelsiz istasyonda tankı gözüyle kontrol eden kimse yoktur. Sızıntı yapan bir tank,
ayarı kaymış bir pompa sayacı veya kayıt dışı çekim ancak şu karşılaştırmayla yakalanır:
**kayıttaki stok** ile **fiziksel ölçüm** arasındaki fark.

**Yakıt Sapma** ekranından (İstasyon Yönetimi menüsü) daldırma çubuğu veya seviye probuyla
okunan gerçek litre girilir. Sistem:

1. O anki kayıt stoğuyla farkı hesaplar (`sapma = ölçüm − kayıt`).
2. Farkı, önceki ölçümden bu yana tanktan geçen hacme (satış + teslimat) oranlar.
3. Eşik aşılırsa **kritik alarm** üretir — Alarm Merkezi'ne düşer ve kritik alarm
   bildirimleri (e-posta/SMS) aynı kuyruktan gönderilir.
4. Kayıt stoğunu ölçüme eşitler; fark, denetim izine `adjustment` hareketi olarak yazılır.

### Teslimat kabul farkı (eksik gelen tanker)

Yakıt sapma takibi tankı izler; ama kayıp çoğu zaman tank<em>a</em> girmeden önce olur.
Bir teslimatın **iki** rakamı vardır:

1. **İrsaliyedeki miktar** — faturalandığımız miktar
2. **Tanka fiilen giren miktar** — boşaltmadan önceki ve sonraki tank seviyesinin farkı

20.000 L yazıp 19.600 L boşaltan bir tanker, günün fiyatıyla ~22.000 TL'lik bir kayıptır ve
tek rakamla kaydedilen bir sistemde hiçbir yerde görünmez.

**Daha kötüsü:** irsaliye rakamı kayıt stoğuna yazıldığında yakıt sapma takibini de
zehirler. Şişmiş kayıt stoğu, eksik gelen yakıtı teslimat anında değil *sonraki günlere
yayılmış* gizemli bir kayıp olarak gösterir — yani operatör sızıntı arar, oysa sorun
tankerdedir. Bu yüzden ölçüm girildiğinde kayıt stoğuna **fiilen giren** miktar yazılır;
fark ayrı bir kalem olarak kayda geçer.

Stok Ekle formunda teslimat öncesi/sonrası tank seviyesi girilir (öncesi, tankın o anki
kayıt seviyesiyle önceden doldurulur). Eşik aşılırsa **kritik alarm** üretilir; alarm mesajı
tedarikçi adını ve irsaliye numarasını içerir, çünkü itiraz ancak tanker şoförü daha
sahadayken yapılabilir.

| Durum | Davranış |
| --- | --- |
| Ölçüm girilmedi | İrsaliyedeki miktar eklenir (eski davranış). Fark alanları **null** kalır — "ölçtük, tuttu" ile "hiç ölçmedik" ayrı şeylerdir |
| Fark tolerans içinde | Fiilen giren eklenir, fark kaydedilir, alarm yok |
| Eksik geldi, eşik aşıldı | Fiilen giren eklenir, fark kaydedilir, **kritik alarm** |
| Fazla geldi | Fark kaydedilir, **alarm yok** — fazlası istasyonun aleyhine değildir ve kritik alarm kuyruğunu doldurması gerçek alarmların kaçırılmasına yol açardı |

Eşikler istasyon bazında ayarlanır ve **ikisi birden** aşılmadıkça alarm çıkmaz
(varsayılan: %0,5 **ve** 100 L). Sadece yüzde kullanılsaydı 500 L'lik bir LPG teslimatında
%0,5 yalnızca 2,5 L eder ve ölçüm hassasiyeti bunun altında kaldığı için sürekli yanlış
alarm üretirdi. Yüzde, **irsaliye** miktarına bölünerek hesaplanır: fiilen girene bölmek,
eksik geldikçe paydayı küçültüp farkı olduğundan büyük gösterirdi.

### Pompa ayarı (kalibrasyon) ve damga

Yakıt sapma takibi tankı, teslimat kabul farkı tankere gireni izler. Üçüncü kayıp
noktası **pompa sayacının kendisidir.** Ayarı kaymış bir pompa:

- **Yasa dışıdır** — akaryakıt sayaçları periyodik muayeneye ve damgaya tabidir.
- **Her dolumda çalar** — pompa fazla gösteriyorsa müşteriden, eksik gösteriyorsa
  işletmeden.
- **Yanlış yere baktırır** — yakıt sapma takibinde açıklanamayan bir kayıp olarak görünür
  ve operatör olmayan bir sızıntıyı aramaya başlar. Teslimat kabul farkıyla tam olarak
  aynı desen: *kaybı kaynağında yakalamazsan, kaynağı belirsiz bir sapmaya dönüşür.*

Pompalar sayfasında **Ayar / Damga** ile bilinen hacimli bir ayar kabına (prover) yapılan
test kaydedilir: kabın gerçek hacmi ile sayacın gösterdiği miktar girilir, sistem hatayı
hesaplar. Ekran, kaydetmeden önce sonucu canlı gösterir — *"her 1000 L'de kaç litre fark
oluşur"* dahil; bu bir tahmin değil, doğrudan aritmetiktir.

**Hata, ayar kabına göre hesaplanır** — sayaç okumasına göre değil. Hatanın büyüklüğü,
gerçekte ne kadar yakıt verildiğine göre anlamlıdır; pompanın kendi (hatalı) rakamına göre
değil.

| Yön | Anlamı |
| --- | --- |
| Hata **+** | Pompa olduğundan fazla gösteriyor — **müşteri aleyhine** |
| Hata **−** | Pompa olduğundan az gösteriyor — **işletme aleyhine** |

Azami kabul edilebilir hata **±%0,5**'tir ve bu bir işletme tercihi değil yasal bir
sınırdır — istasyon ayarıyla değiştirilemez (aynı gerekçe: güvenlik alarmlarının yükseltme
süresi). Aşılırsa **kritik alarm** üretilir. *Mevzuattaki güncel değeri kendi muayene
kuruluşunuzla teyit edin; değişirse kodda tek noktadan güncellenir.*

**Damga takibi**: her testte periyodik muayene damgasının geçerlilik bitişi ve belge
numarası kaydedilebilir. Süresi dolmuş damgayla satış yapmak yasa dışıdır, bu yüzden
dolmuş damga **kritik**, dolmaya 30 günden az kalan damga **uyarı** alarmı üretir. Damga
yenilenip yeni bir test girildiğinde alarm kendiliğinden çözülür.

Damga tarihi **girilmemiş** pompa için alarm üretilmez: veriyi henüz girmemiş her istasyonu
alarma boğmak, özelliği kullanılamaz kılardı. Pompa kartında bu durum *"damga tarihi
girilmemiş"* olarak ayrıca görünür — "test edilmedi" ile "test edildi, geçti" ayrı
şeylerdir.

### Tedarikçi karnesi

Tek bir teslimattaki %0,4'lük fark tolerans içindedir ve alarm üretmez. Ama aynı tedarikçi
**her seferinde** %0,4 eksik getiriyorsa bu bir tolerans değil bir **desendir** ve yalnızca
toplamda görünür. Yakıt Stoku sayfasındaki *Teslimat Kabul Farkı — Tedarikçi Karnesi*
tablosu tedarikçi başına kümülatif farkı gösterir; alarm tek teslimata, bu rapor ilişkiye
bakar. Yalnızca ölçümü girilmiş teslimatlar sayılır.

### Otomatik tank seviye okuma (ATG probu)

Ölçüm elle girildiği sürece bu özellik insan disiplinine bağlıdır: pratikte ya seyrek
yapılır ya hiç, ve sızıntı tespiti sessizce çalışmaz hale gelir. Gerçek istasyonların
tanklarında zaten bir seviye probu bulunur (Veeder-Root TLS, Start Italiana, OPW vb.).

`TankGaugeDriver` (bkz. `services/tankGaugeDriver.ts`) o probu sisteme bağlamak içindir —
`SafetySensorDriver`/`DispenserDriver`/`PrinterDriver` ile **aynı desen**: bugün tek
uygulama `noopTankGaugeDriver` (hep `null` döner, "prob bağlı değil"). Gerçek donanım
bağlanınca arayüzü uygulayan bir sürücü yazılıp `setTankGaugeDriver()` ile devreye alınır;
periyodik okuma döngüsüne dokunmaya gerek kalmaz.

Otomatik ölçüm, elle girilen ölçümle **aynı yoldan** (`recordReading`) geçer: eşik
kontrolü, alarm üretimi ve tank düzeltmesi tek yerde kalır. Ölçüm satırında kaynak
`auto` olarak işaretlenir ve panelde "Seviye probu" rozetiyle gösterilir — kullanıcı
sütunu boş görünüp "kim ölçtü?" sorusu havada kalmasın diye.

**Üç koruma:**

| Durum | Davranış | Neden |
| --- | --- | --- |
| Prob `null` döndürdü | Hiçbir ölçüm kaydedilmez | `null`, "sıfır litre" değildir. Okunamayan probu boş tank saymak doğrudan yanlış bir kayıp alarmı üretirdi. |
| Dolum sürüyor | Ölçüm atlanır | Yakıt akarken seviye hem düşer hem çalkalanır; probun o anki okuması kararsızdır. Gerçek ATG sistemleri de "sakin dönem" bekler. |
| Son ölçümden 1 saat geçmedi | Ölçüm atlanır | Sapma oranı iki ölçüm arasındaki hacme bölünür. 5 dakikada bir ölçülse aradaki hacim sıfıra yaklaşır ve probun normal salınımı yüzde olarak devasa görünürdü. |

Otomatik ölçümün **kullanıcısı yoktur**: denetim izinde `user_id` boş kalır. Sistemin
kendi yaptığı bir düzeltmeyi rastgele bir kullanıcıya yazmak denetim izini yanıltıcı
hale getirirdi.

### Sapma oranı neden kapasiteye göre hesaplanmıyor?

50.000 L'lik bir dolaşımda 200 L fark sıcaklık ve sayaç toleransıyla açıklanabilir;
2.000 L'lik dolaşımda aynı 200 L ciddi bir kayıptır. Oranı tank kapasitesine bölmek bu
ayrımı tamamen kaybettirirdi, bu yüzden payda **hareket hacmidir**.

### İki eşik birden

Kritik alarm, iki koşul da sağlandığında oluşur:

| Ayar | Varsayılan | Amaç |
| --- | --- | --- |
| Sapma oranı eşiği | %0.5 | Sektörde kabul gören ölçüm/sıcaklık toleransı |
| En düşük sapma (litre) | 50 L | Az satış olan günlerde küçük ölçüm hatalarının yüzde olarak büyük görünüp yanlış alarm üretmesini engeller |

Her iki değer de istasyon bazında ayarlanabilir.

### Kümülatif bakış

Tek tek ölçümlerdeki artı/eksi salınımlar uzun vadede birbirini götürür; **sürekli aynı
yönde biriken** bir toplam ise gerçek bir kayıptır. Bu yüzden ekranın üstündeki özet
kartları son ölçümü değil kümülatif farkı gösterir ve yalnızca kümülatif kayıp eşiği
aştığında kırmızıya döner.

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

Seed (roller, `admin`/`<slug>-admin` hesapları, ilk istasyon) **container her başladığında
otomatik** çalışır (Dockerfile'ın `CMD`'i) - idempotent olduğu için zaten var olan veriye
dokunmaz, ilk deploy'da manuel bir seed adımı atmanıza gerek yoktur. (`railway run npm run
seed` gibi bir komut **çalıştırmayın** - bu, Railway'deki gerçek volume'a değil sizin kendi
bilgisayarınıza yazar.) Giriş bilgileri: `admin` / `SEED_ADMIN_PASSWORD` (varsayılan
`ChangeMe!12345`), ilk girişte şifre değiştirme zorunludur.

Her iki platformda da ücretsiz katman genelde ya kalıcı disk sunmaz ya da inaktivitede
uykuya geçirir — gerçek 7/24 çalışma için en ucuz ücretli plan (aylık birkaç dolar)
gerekir.

### Kendi sunucunuzda (VPS)

- Uygulamayı bir process manager (`pm2`, `systemd`) ile arka planda ve sunucu yeniden
  başlasa bile otomatik ayağa kalkacak şekilde çalıştırın.
- HTTPS sonlandırması için önüne bir ters proxy (nginx, Caddy) koyabilirsiniz, ama zorunlu
  değil — Express doğrudan da servis edebilir; sadece sertifika yönetimini proxy'ye
  bırakmak genelde daha kolaydır.
- SQLite veritabanı dosyasının (`DATABASE_PATH`) düzenli olarak yedeklenmesini sağlayın —
  bkz. aşağıdaki "Otomatik yedekleme" bölümü, sunucu bunu kendi başına yapabilir.

## Otomatik yedekleme, sağlık kontrolü ve testler

**Yedekleme**: `BACKUP_DIR` ortam değişkeni ayarlanırsa (varsayılan: boş = kapalı), sunucu
`better-sqlite3`'ün kendi `.backup()` API'siyle (WAL modunda bile tutarlı bir anlık görüntü
alır — ham dosya kopyalamaktan farklı olarak yarım yazılmış bir sayfayı yakalama riski yoktur)
`BACKUP_INTERVAL_HOURS`'ta bir (varsayılan 24) zaman damgalı bir yedek alır. Yedek dosyası
diske yazılmadan önce **AES-256-GCM ile şifrelenir** (`.sqlite.enc` uzantısı) — bu yedeklerin
üçüncü bir tarafın (ör. bir veri merkezinin gözetimindeki bulut yedekleme hizmeti) depolamasına
taşınması ihtimaline karşı savunma-derinliği amaçlıdır; anahtar `SETTINGS_ENCRYPTION_KEY`
(yoksa `SESSION_SECRET`'tan türetilir) — yeni bir zorunlu ortam değişkeni eklenmedi.
`BACKUP_RETENTION_COUNT`'tan (varsayılan 14) eski yedekleri otomatik siler.

Geri yüklemek için önce şifreli yedeği çözün:
```
npm run decrypt-backup -- yedek-dosyasi.sqlite.enc geri-yuklenecek.sqlite
```
(yedeğin alındığı sunucudaki AYNI `SESSION_SECRET`/`SETTINGS_ENCRYPTION_KEY` ortamda tanımlı
olmalı), sonra çıkan dosyayı `DATABASE_PATH`'in üzerine kopyalayıp sunucuyu yeniden başlatın.

### Yedek doğrulama (geri yükleme tatbikatı)

Yedekler alınıyor, şifreleniyor ve rotasyona giriyordu — ama hiçbir aşamada
**doğrulanmıyordu**. Şifresi çözülebiliyor mu, geçerli bir SQLite dosyası mı, içinde veri
var mı: kimse bakmıyordu. **Hiç geri yüklenmemiş bir yedek, yedek değildir.**

Her yedeğin ardından sistem yedeği **gerçekten açar ve okur**:

1. Şifresini çözer (geçici bir dosyaya)
2. SQLite olarak açar ve `PRAGMA integrity_check` çalıştırır
3. Sistemin çalışması için vazgeçilmez tabloların varlığını kontrol eder
4. Canlı veritabanında verisi olan bir tablonun yedekte **boş** olmadığını doğrular
5. Geçici dosyayı — **ve `-wal`/`-shm` yan dosyalarını** — siler

Herhangi biri başarısız olursa **kritik alarm** üretilir (ve alarm yükseltme zincirine
girer). Yedek düzelince alarm kendiliğinden çözülür; operatörün elle temizlemesi gereken
bir kalıntı bırakılmaz.

**Satır sayılarının birebir eşit olması aranmaz.** Yedek, alındığı andaki anlık
görüntüdür; eşitlik beklemek sürekli yanlış alarm üretirdi. Anlamlı olan kontrol
"canlıda veri var ama yedekte hiç yok" durumudur.

**En sinsi senaryo şifreleme anahtarının değişmesidir:** dosyalar diskte durur, boyutları
doğrudur, isimleri doğrudur — ama hiçbiri açılamaz. Bunu ancak açmayı deneyerek
öğrenebilirsiniz, ve bunu felaket günü öğrenmek istemezsiniz.

Geçici olarak çözülen dosya `try/finally` ile her durumda silinir. SQLite'ı açmak `-wal` ve
`-shm` yan dosyaları da oluşturur ve bunlar da **çözülmüş veritabanı içeriği** taşır;
yalnızca ana dosyayı silmek, şifrelemenin engellemek için var olduğu şeyi diskte bırakmak
olurdu.

**Sağlık kontrolü**: `GET /api/health` kimlik doğrulama gerektirmez, veritabanı bağlantısını
gerçekten sorgulayıp (`dbOk`) çalışma süresini (`uptimeSeconds`) döner — uptime izleme
araçları (UptimeRobot vb.) veya konteyner orkestrasyon health-check'leri için uygundur.
Cevapta ayrıca `lastBackupVerification` alanı bulunur — dışarıdan izleme *"sistem ayakta ama
yedeği bozuk"* durumunu da görebilsin diye. Bu alan sağlık **durumunu** düşürmez: bozuk yedek
acil bir kesinti değil kritik bir alarmdır ve 503 döndürmek izlemeyi yanlış yere — servis
kesintisine — yönlendirirdi. Ayrıca
`.github/workflows/uptime-check.yml`, GitHub Actions üzerinden 10 dakikada bir bu uç noktayı
dışarıdan (sunucunun kendi süreçlerinden bağımsız olarak) kontrol eder — çalışması için repo
ayarlarında (Settings → Secrets and variables → Actions → Variables) `HEALTH_CHECK_URL` adında
canlı sunucunun tam `/api/health` adresini içeren bir repository variable tanımlamanız gerekir.
Kontrol başarısız olursa GitHub, repoyu izleyenlere otomatik olarak bir e-posta gönderir (ek bir
hesap/servis gerekmez).

**Testler**: `npm run test` (server workspace), kritik iş mantığı için (yakıt stoğu
ağırlıklı ortalama maliyet, indirim kodu doğrulama/kullanım istatistikleri, TOTP, şifre
politikası, `chargeAmount`) vitest ile birim testleri çalıştırır; kendi geçici SQLite
dosyasını kullanır, gerçek veritabanınıza dokunmaz. `.github/workflows/ci.yml`, her
push/PR'da typecheck + lint + test + build adımlarını otomatik çalıştırır.

## Komutlar

| Komut | Açıklama |
|---|---|
| `npm run dev:server` / `dev:web` | Geliştirme sunucularını başlatır |
| `npm run build` | Backend + frontend derlemesi |
| `npm run typecheck` | Tüm workspace'lerde TypeScript tip kontrolü |
| `npm run lint` | Tüm workspace'lerde ESLint |
| `npm run test` | Backend birim testleri (vitest) |
| `npm run seed --workspace server` | Roller, admin kullanıcı, istasyon, pompa, fiyat verisini oluşturur |
