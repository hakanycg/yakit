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
- Tek istasyon sorguları (panel, kiosk, rapor) 10 ms'in altında ve toplam veri büyüdükçe
  **sabit** kalıyor — indeksli oldukları için. Bunlar sunucu boyutlandırmasında baskın değil.
- **Tek darboğaz konsolide rapor:** 100 istasyonda 1.6 sn, 1000 istasyonda ~16 sn.
  Bu bir donanım sorunu değil, sorgu şekli sorunu — daha güçlü sunucu almak yerine
  **günlük özet (rollup) tablosu** yazılmalı. Karar #81 ile birlikte verilmeli:
  rollup yapılırsa konsolide rapor da sabit zamana iner ve CPU gereksinimi düşer.


Bugün Railway üzerinde çalışıyor. Kendi veri merkezine geçiş kararı verildiğinde:

- **Sağlayıcı seçimi ve kapasite planı** — kaç istasyon, kaç kiosk, hangi büyüme eğrisi.
- **Çift ISP (uplink yedekliliği)** — tek hat, personelsiz istasyonda tek hata noktası.
- **Yedekleme + felaket kurtarma planının DC'ye uyarlanması** — mevcut şifreli yedekleme
  ve geri yükleme tatbikatı altyapısı hazır, hedefi değişecek.
- **Railway'den kesintisiz geçiş** — kiosk'lar 7/24 açık, kesinti dolum yapamamak demek.
- **Uplink sağlığı ve genel sistem durumu izleme** — dışarıdan uptime kontrolü mevcut
  (GitHub Actions), DC'ye geçince `HEALTH_CHECK_URL` güncellenecek.

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
