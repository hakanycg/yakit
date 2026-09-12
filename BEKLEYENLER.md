# Bekleyen İşler

Yazılım tarafında yapılabilecek işler bittiğinde geriye kalanlar bunlar. Hiçbiri kod
yazarak çözülmüyor: her biri ya **işletmenin bir kararını**, ya bir **kurumdan teyit**,
ya da **sahada fiziksel bir işi** bekliyor. Bu dosyanın amacı, o kararlar verildiğinde
"neyi kim soracaktı, sonra ne yapılacaktı" sorusunun cevabının kaybolmaması.

Güncelleme: 26 Ağustos 2026

---

## 1. Kiosk ödeme donanımı — tedarikçiden cevap bekliyor

Kiosk ekranı tek başına temassız ödeme **alamaz**: temassız ödeme sertifikalı EMV
kernel'i ve PCI sertifikalı donanım gerektirir, ucuz USB NFC okuyucular kartın seri
numarasını okur ama EMV işlemi yapamaz. Doğru ürün kategorisi kiosk'un yanına ayrı bir
POS koymak değil, **ödeme modülü gömülü kiosk**.

**Tedarikçiye sorulacak iki soru:**

1. Ödeme modülü gömülü bir model var mı?
2. Otomasyona **"onaylandı / reddedildi" sinyali veren bir entegrasyon protokolü**
   destekliyor mu?

İkincisi belirleyici: personelsiz istasyonda pompayı yetkilendiren tek şey teyit edilmiş
ödemedir. Cihaz bağımsız çalışıp sadece kendi fişini basıyorsa, sistem o ödemeyi göremez
— pompayı ya kör açarız (parası alınmamış dolum riski) ya da müşteri POS'tan sonra
kiosk'ta bir işlem daha yapmak zorunda kalır.

**Üçüncü soru (bedava fayda):** cihaz ÖKC'li mi? Öyleyse aşağıdaki #4 (yasal fiş) da
aynı anda kapanır.

**Vendor cevabı beklenmeden yapılabilecek kısım artık hazır:** `agent/src/posDriver.ts`
(`okcDriver.ts`/`printerDriver.ts` ile aynı desende, noop sürücü + `setPosDriver()`),
`agent/src/server.ts`'te aynı desende bir yerel `/pos/charge` ucu, `payment_method`
olarak `pos` kullanılınca reddedilmeyen bir iyzico/fleet dışı yol ve **iade yolunun
şimdilik açıkça reddedilmesi** (`refundService.ts` — donanım gelmeden bir POS ödemesini
"iade edildi" diye kaydetmek, parası hiçbir yere gitmeyen sahte bir başarı olurdu),
gün sonu mutabakatında kendi satırı (`reconciliationService.ts` zaten jenerik,
kod değişikliği gerekmedi). **Cevap gelince kalan iş:** bu arayüzü uygulayan GERÇEK
sürücüyü yazıp `setPosDriver()` ile devreye almak, kiosk'un merkez sunucuya "POS ile
tahsil edildi" diyeceği GÜVEN ucunu vendor'ın protokolüne göre tasarlamak (bu, hangi
vendor seçilirse seçilsin protokol netleşmeden tahmin edilerek yazılmayacak — iyzico'nun
imza sırasının resmi dokümantasyon olmadan asla uydurulmamış olmasıyla aynı gerekçe),
ve POS iade yolunu gerçek donanıma bağlamak. Kiosk akışında başka hiçbir şey değişmez.

**Ayrıca karar verilecek:** POS gelince iyzico kapatılsın mı? İki kanalı birden
çalıştırmak, her ödeme kanalı için ayrı mutabakat satırı ve ayrı iade yolu demek.

> Kapsam dışı bırakıldı: QR ile telefondan ödeme. Temassız POS zaten Apple/Google Pay'i
> karşılıyor; aynı işi ikinci kez yapmak olurdu.

## 2. Filo portalinden kartla anlık bakiye yükleme — ticari karar

Bugün portalde **yükleme talebi** var (talep para taşımaz, personel tahsil edince
onaylar). Kartla anlık yükleme bilinçli olarak yapılmadı.

**Sebep ticari, teknik değil:** filo yakıt alımı bugün ödeme sağlayıcısına hiç uğramıyor
(`fleetService.chargeAccount` sadece bakiyeden düşer), yani filo cirosunda **%0
komisyon** var. Yüklemeyi karta bağlamak komisyonu hacmin %0'ından %100'üne taşır
(~%1,5–2).

**Yeşil ışık yakılırsa önce çözülmesi gereken dört şey:**

1. Yükleme bir **avans/depozitodur** — otomatik e-faturayı tetiklememeli ve ciroya
   sayılmamalı.
2. Gün sonu mutabakatının `expectedTotal` değeri işlemlerden türetiliyor, yüklemeyi
   ıskalar — kendi satırı gerekir.
3. `refunds.transaction_id` NOT NULL; bir yükleme iadesi mevcut modele oturmuyor.
4. Para doğru istasyonun iyzico hesabına düşmeli (istasyon bazlı yapılandırma mevcut).

## 3. Altyapı: veri merkezine geçiş

**Kapasite artık ölçüldü — sağlayıcıyla konuşurken elde sayı var** (`npm run benchmark`,
ayrıntı README "Kapasite ölçümü"):

- İşlem başına ~434 bayt (indeksler dahil) → 1000 istasyon × 300 işlem/gün ≈ **48 GB/yıl**.
  Küçük/orta bir VPS'in disk kapasitesi için bile önemsiz.
- Tek istasyon sorguları (panel, kiosk, rapor) 10 ms'in altında ve toplam veri büyüdükçe
  **sabit** kalıyor — indeksli oldukları için. Sunucu boyutlandırmasında baskın değil.
- **Konsolide rapor darboğazı ÇÖZÜLDÜ** (#155, `station_daily_rollups` özet tablosu):
  100 istasyon/1.8M işlemde 1.6 sn'den 363 ms'e indi. Artık istasyon sayısı arttıkça
  ham işlem sayısına değil, istasyon×gün özet satırına bakıyor — sabit zamana yakın.
- **Ölçülmeyen tek şey: eşzamanlı YAZMA yükü.** Yukarıdaki ölçüm disk büyümesi ve
  okuma/rapor sorgu hızını test etti; yüzlerce/binlerce istasyonun aynı anda işlem+
  heartbeat gönderdiği eşzamanlı yazma senaryosu hiç yük testine tabi tutulmadı.
  SQLite tek-yazıcı kilidine sahip — düşük/orta yoğunlukta (onlarca-yüzlerce istasyon,
  trafik doğal dağınık) sorun çıkarmaz, ama gerçek bir eşzamanlı yazma yük testi
  yapılmadan "X istasyona kadar güvenlidir" diye kesin bir tavan sayısı verilemez.

**12 Eylül 2026 görüşmesi — ölçek stratejisi kararı:** "Türkiye'deki çoğu istasyon"
hedefi ile "küçük bir VPS" arasındaki gerilim şöyle çözüldü: doğru soru "büyük mü
küçük mü sunucu" değil, **mimariyi ne zaman yatay ölçeklendireceğimiz**.
- **Şimdilik (birkaç düzine – birkaç yüz istasyon, tek/birkaç dağıtım şirketi):**
  orta boy tek VPS (4-8 vCPU, 8-16GB RAM, NVMe SSD) yeterli — yukarıdaki sayılar
  bunu destekliyor.
- **"Çoğu istasyon" ölçeğine gelince:** tek dev sunucuyu büyütmek yerine, zaten kurulu
  olan dağıtım şirketi (bayi) katmanını (#117) kullanıp **büyük bayi/bölge başına
  ayrı bir kurulum** (yatay ölçek) ya da tek birleşik platform kalınacaksa SQLite'tan
  PostgreSQL'e geçiş — bu, gerçek istasyon sayısı yüzleri aştığında yeniden masaya
  yatırılacak bir mimari kararı, bugünün değil.

**Hosting/domain kararı (12 Eylül 2026):**
- Railway süresi bitiyor, kendi altyapıya geçiliyor.
- **Sunucu konumu: Türkiye** (KVKK açısından kişisel verinin yurt içinde kalması avantajı).
- **Hosting türü: Cloud Server / Cloud VPS** (Natro Cloud VPS / Turhost Cloud / gerekirse
  Radore) — "klasik VPS" veya "Dedicated Server" değil. Fark: klasik VPS ve dedicated
  server TEK fiziksel makineye bağlıdır (o donanım arızalanırsa kesinti saatler-günler
  sürer, büyütme fiziksel müdahale ister); Cloud Server birden fazla fiziksel sunucudan
  oluşan bir havuzda çalışır (donanım arızasında otomatik taşınır, disk/RAM dakikalar
  içinde API'den büyütülür). Sistem 7/24 çalışıp internetsizken satış yapamadığı için
  (bkz. `web/src/kiosk/useConnectivity.ts`) donanım arızasına dayanıklılık, ham işlem
  gücünden daha kritik — bu yüzden Dedicated Server'ın sunduğu fazla güç gereksiz,
  Cloud Server'ın esnekliği daha değerli.
- **Domain: `.com`** (şirket belgesi gerektiren `.com.tr` değil) — isim henüz kesinleşmedi.
- **Disk stratejisi:** sabit büyük bir disk (ör. 500GB) baştan alınmayacak. VPS'in kendi
  diski (OS+uygulama, 50-100GB, çoğu pakette dahil) + ayrı, **büyütülebilir bir Block
  Storage** (veritabanı+arşiv+yedek için, 100GB'tan başlayıp kullanım arttıkça
  büyütülür). Sağlayıcı seçiminde belirleyici soru: **"Block Storage ürününüz var mı ve
  kesintisiz büyütülebiliyor mu?"**
- **Sonraki adım:** kullanıcı domain + VPS satın alacak; alınca IP adresi + erişim
  yöntemi (SSH bilgisi mi, yoksa Claude'un hazırlayacağı script kullanıcı tarafından mı
  çalıştırılacak) kararlaştırılıp kurulum başlayacak.

**"Çok yüksek/sürekli yük" senaryosu — ileride masaya yatırılacak (12 Eylül 2026):**
Türkiye'de ~12.500 EPDK lisanslı istasyon var; "çoğu istasyon" hedefi somutlaşırsa
(örn. 10.000 istasyon):
- Günde ~3 milyon işlem, yılda ~1.1 milyar işlem → yılda ~475GB (işlemler hiç
  arşivlenmiyor, bkz. yukarısı), 10 yıllık TTK saklamasında ~4.75TB.
- Her istasyon ajanı 60sn'de bir heartbeat + 120sn'de bir önbellek çekimi atıyor →
  toplamda saniyede ~250 istek, sürekli. Artı gerçek işlem/alarm/panel trafiği, artı
  10.000-30.000 eşzamanlı WebSocket bağlantısı.
- **Asıl darboğaz bu ölçekte sunucu büyüklüğü değil, SQLite'ın tek-yazıcı kilidi** —
  ne kadar güçlü donanım alınırsa alınsın değişmeyen bir mimari sınır.
- Bu ölçekte gerekecek olan: tek sunucu değil, **çok parçalı mimari** (yük dengeleyici +
  birden fazla uygulama sunucusu, SQLite yerine PostgreSQL veritaban katmanı, WebSocket
  yayını için Redis/pub-sub, ayrı nesne depolama). Dedicated Server'ın gerçekten
  mantıklı olduğu TEK yer burada olurdu: PostgreSQL veritabanı katmanı (paylaşımsız,
  garantili G/Ç performansı için).
- **Alternatif (tercih edilen yön):** tek dev merkezi veritabanı yerine, zaten kurulu
  dağıtım şirketi (bayi) katmanını (#117) kullanıp büyük bayi/bölge başına ayrı bir
  kurulum çalıştırmak — yatay ölçek, Postgres'e geçiş gibi büyük bir mühendislik
  yatırımı gerekmeden.
- Bu, gerçek istasyon sayısı yüzleri aştığında karar verilecek bir mimari dönüm noktası;
  bugünün Cloud VPS kararını değiştirmiyor.

Geçiş sırasında ayrıca:

- **Çift ISP (uplink yedekliliği)** — tek hat, personelsiz istasyonda tek hata noktası.
- **Yedekleme + felaket kurtarma planının DC'ye uyarlanması** — mevcut şifreli yedekleme
  ve geri yükleme tatbikatı altyapısı hazır, hedefi değişecek.
- **Railway'den kesintisiz geçiş** — kiosk'lar 7/24 açık, kesinti dolum yapamamak demek.
  DNS TTL önceden düşürülüp düşük trafik saatinde geçiş, Railway birkaç gün paralelde
  yedek olarak tutulacak.
- **Uplink sağlığı ve genel sistem durumu izleme** — dışarıdan uptime kontrolü mevcut
  (GitHub Actions), DC'ye geçince `HEALTH_CHECK_URL` güncellenecek.
- **Kiosk ajanlarının merkez sunucu adresi güncellenecek** — sahadaki/test ortamındaki
  ajan konfigürasyonları yeni domaine çevrilecek.

## 4. Regülasyon: teyit bekleyen konular

Hiçbiri tahminle kapatılmamalı; ilgili kurumdan/danışmandan yazılı teyit gerekiyor.

- **TS 12820 — Faz 2 (personelsiz) geçişi.** Sistem personelsiz çalışacak şekilde
  yazıldı; hukuki çerçevenin teyidi alınmadan saha açılmamalı.
- **EPDK İstasyon Otomasyon Sistemi (İOS) entegrasyonu.** `automationDriver.ts` hazır
  bekleyen bir soyutlama; hangi vendor/protokol olduğu netleşince bağlanacak.
- **ÖKC (yazar kasa) yasal fiş zorunluluğu.** Mevcut Uyumsoft e-Fatura/e-Arşiv
  entegrasyonu yasal olarak yeterli mi, yoksa fiziksel ÖKC şart mı? `okcDriver.ts` aynı
  desende hazır bekliyor. **Bu soru #1 ile birlikte sorulabilir.**
- **Filo iade faturası.** Kesilmiş bir e-Faturanın düzeltilmesi (iade faturası) usulü
  netleşmeden otomatik yapılmamalı.
- **Log arşivleri için zaman damgası (TÜBİTAK KamuSM).** Denetim izinin sonradan
  değiştirilmediğini kanıtlamak gerekiyorsa. **İmzalanacak şey artık hazır:** arşivleme
  her dosya için `content_sha256` (şifresiz içeriğin özeti) ve `file_sha256` (diskteki
  dosyanın özeti) üretip `archive_files` tablosuna yazıyor; damga bu özetleri imzalayacak.
- **Denetim kaydı saklama süresi.** Arşivleme varsayılanı 24 ay (taban 12 ay) — bu bir
  **işletme varsayılanı, hukuki bir sayı değil**. KVKK bir süre vermez, süreyi veri
  sorumlusu kendi saklama ve imha politikasında belirler. Avukatla netleşince
  `ARCHIVE_AUDIT_LOG_MONTHS` ile değiştirilmeli.

## 5. Saha işi: gerçek istasyon kurulunca

- **Yangın/gaz alarm santralinin röle çıkışını kablola.** `safetySensorDriver.ts` sinyali
  okumaya hazır; bugün noop sürücüyle çalışıyor. Bu kablolama yapılmadan acil durdurma
  zinciri fiziksel dünyaya bağlı değildir.
- **Termal fiş yazıcısını bağla.** `agent/src/printerDriver.ts` hazır; bugün yazdırma
  isteği yalnızca loglanıyor, fiziksel çıktı yok.
