import { createContext, useContext, useState, type ReactNode } from "react";

export type KioskLang = "tr" | "en";

type Dict = Record<string, string>;

/**
 * Kiosk'a ozel cok dilli metin sozlugu. Yalnizca musteri karsisindaki kiosk akisinda
 * kullanilir - operator/admin panelleri kapsam disidir, Turkce kalmaya devam eder.
 * Basit {degisken} interpolasyonu desteklenir (bkz. t() fonksiyonu).
 */
const DICTS: Record<KioskLang, Dict> = {
  tr: {
    "loading": "Yukleniyor...",
    "stationNotFound.title": "Istasyon Bulunamadi",
    "stationNotFound.hint": "Bu kiosk terminalinin adresi hatali olabilir. Lutfen istasyon yoneticinizle iletisime gecin.",
    "error.stationLoadFailed": "Istasyon yuklenemedi.",
    "error.transactionCreateFailed": "Islem olusturulamadi.",
    "error.paymentInfoLoadFailed": "Odeme sonrasi islem bilgisi alinamadi. Lutfen yeni bir islem baslatin.",
    "creating.hint": "Pompa rezerve ediliyor ve odeme ekranina yonlendiriliyorsunuz...",
    "iyzicoWait.title": "Odeme Sonucu Bekleniyor",
    "iyzicoWait.hint": "iyzico odeme sonucunuz dogrulaniyor, lutfen bekleyin...",

    "fuel.benzin": "Benzin",
    "fuel.motorin": "Motorin",
    "fuel.lpg": "LPG",
    "pumpStatus.idle": "Musait",
    "pumpStatus.reserved": "Rezerve",
    "pumpStatus.dispensing": "Dolum Yapiliyor",
    "pumpStatus.fault": "Ariza",
    "pumpStatus.offline": "Devre Disi",
    "transactionStatus.created": "Olusturuldu",
    "transactionStatus.paid": "Odendi",
    "transactionStatus.authorized": "Yetkilendirildi",
    "transactionStatus.dispensing": "Dolum Yapiliyor",
    "transactionStatus.completed": "Tamamlandi",
    "transactionStatus.cancelled": "Iptal Edildi",
    "transactionStatus.failed": "Basarisiz",

    "plate.title": "Hosgeldiniz",
    "plate.subtitle": "Baslamak icin arac plakanizi girin veya otomatik plaka tanima (LPR) ile taratin.",
    "plate.label": "Plaka",
    "plate.placeholder": "06 ABC 123",
    "plate.lprFailed": "Plaka net okunamadi, lutfen manuel giriniz.",
    "plate.invalid": "Gecerli bir plaka giriniz (orn: 06 ABC 123).",
    "plate.scanning": "Kamera taraniyor...",
    "plate.scanButton": "LPR ile Otomatik Tara",
    "plate.continue": "Devam Et",
    "plate.lprNote": "Not: Bu ortamda fiziksel kamera donanimi bulunmadigindan LPR taramasi simule edilmektedir.",
    "action.back": "Geri",

    "pump.title": "Pompa Secin",
    "pump.subtitle": "Aracinizin bulundugu musait pompayi seciniz.",

    "fuelStep.title": "Yakit Tipi Secin",
    "fuelStep.subtitle": "{pump} icin desteklenen yakit tipleri.",
    "fuelStep.outOfStockTitle": "Bu yakit tipi su anda tukenmis.",
    "fuelStep.outOfStock": "Tukendi",
    "fuelStep.perLiter": "{price} / L",

    "amount.title": "Miktar Secin",
    "amount.modeAmount": "Tutar Gir",
    "amount.modeLiters": "Litre Gir",
    "amount.modeFullTank": "Depoyu Doldur",
    "amount.customAmountLabel": "Ozel tutar (TL)",
    "amount.litersLabel": "Litre miktari",
    "amount.estimatedTotal": "Tahmini tutar: {amount}",
    "amount.fullTankHint": "Depo dolum sensoru algilandiginda otomatik olarak durdurulur. Maksimum tutar tahmini onceden gosterilir.",
    "amount.useLoyalty": "Sadakat puanlarimi kullan ({points} puan = {value} indirim)",
    "amount.discountCodeLabel": "Indirim Kodu (opsiyonel)",
    "amount.discountCodePlaceholder": "orn: YAZ2026",
    "amount.checkingCode": "Kontrol ediliyor...",
    "amount.applyCode": "Uygula",
    "error.codeInvalid": "Kod dogrulanamadi.",
    "amount.codeApplied": "\"{code}\" uygulandi: -{amount}",
    "amount.estimatedCharge": "Odenecek tahmini tutar: {amount}",
    "amount.invalidAmount": "Gecerli bir tutar giriniz.",
    "amount.invalidLiters": "Gecerli bir litre miktari giriniz.",
    "action.continue": "Devam Et",

    "payment.iyzicoTitle": "Guvenli Odeme (iyzico)",
    "payment.discountApplied": "Indirim uygulandi: -{discount} (asil tutar: {total})",
    "payment.estimateNote": "Tahmini tutar; gercek tutar dolum tamamlandiginda kesinlesir.",
    "payment.iyzicoSecureNote": "Kart bilgileriniz bu kiosk'a degil, dogrudan iyzico'nun guvenli odeme sayfasina girilir.",
    "payment.cancel": "Islemi Iptal Et",
    "payment.payWithCard": "Kart ile Ode",
    "payment.preparingForm": "Odeme formu hazirlaniyor...",
    "error.iyzicoStartFailed": "iyzico odeme formu baslatilamadi.",
    "payment.simulatedTitle": "Sanal Odeme",
    "payment.cardHolderLabel": "Kart Uzerindeki Isim",
    "payment.cardNumberLabel": "Kart Numarasi",
    "payment.monthLabel": "Ay",
    "payment.yearLabel": "Yil",
    "payment.cvvLabel": "CVV",
    "payment.confirm": "Odemeyi Onayla",
    "payment.processing": "Odeme isleniyor...",
    "error.paymentRejected": "Odeme reddedildi.",
    "error.paymentFailed": "Odeme sirasinda hata olustu.",
    "payment.simulationNote": "Bu bir sanal odeme simulasyonudur; gercek banka baglantisi kurulmaz.",

    "dispense.authorizing": "Pompa Yetkilendiriliyor...",
    "dispense.inProgress": "Dolum Yapiliyor",
    "dispense.plateAndPump": "Plaka: {plate} — Pompa #{pump}",
    "dispense.amountLabel": "Dolum Miktari",
    "dispense.currentTotalLabel": "Anlik Tutar",
    "dispense.waitNote": "Lutfen bekleyin, dolum tamamlaninca islem otomatik olarak sonuclanacaktir. Durum: {status}",

    "receipt.failedTitle": "Islem Tamamlanamadi",
    "receipt.completedTitle": "Islem Tamamlandi",
    "receipt.cancelledDefault": "Islem iptal edildi.",
    "receipt.successNote": "Aracinizin yakit dolumu basariyla tamamlandi.",
    "receipt.tankFullNote": "Depo dolum sirasinda tukendigi icin islem {liters} ile sinirli kaldi. Anlayisiniz icin tesekkur ederiz.",
    "receipt.plate": "Plaka",
    "receipt.fuel": "Yakit",
    "receipt.amount": "Miktar",
    "receipt.pricePerLiter": "Litre Fiyati",
    "receipt.fuelValue": "Yakit Degeri",
    "receipt.discount": "Indirim",
    "receipt.chargedAmount": "Odenen Tutar",
    "receipt.totalAmount": "Toplam Tutar",
    "receipt.pointsEarned": "Kazanilan Puan",
    "receipt.transactionNo": "Islem No",
    "receipt.date": "Tarih",
    "receipt.restart": "Yeni Islem Baslat",
    "receipt.sendReceiptTitle": "Makbuzu Gonder",
    "receipt.emailLabel": "E-posta (opsiyonel)",
    "receipt.emailPlaceholder": "ornek@eposta.com",
    "receipt.phoneLabel": "Telefon (opsiyonel)",
    "receipt.phonePlaceholder": "05xx xxx xx xx",
    "receipt.emailSent": "E-posta gonderildi.",
    "receipt.emailFailed": "E-posta gonderilemedi: {reason}",
    "receipt.smsSent": "SMS gonderildi.",
    "receipt.smsFailed": "SMS gonderilemedi: {reason}",
    "receipt.sentGeneric": "Makbuz gonderildi.",
    "error.receiptSendFailed": "Makbuz gonderilemedi.",
    "receipt.sending": "Gonderiliyor...",
    "receipt.send": "Gonder",

    "idle.title": "Hala orada misiniz?",
    "idle.body": "Uzun suredir bir islem yapilmadi. {seconds} saniye icinde islem sifirlanacak.",
    "idle.continue": "Devam Ediyorum",

    "privacy.linkLabel": "Kisisel Verilerin Korunmasi Hakkinda",
    "privacy.title": "Kisisel Verilerin Korunmasi Hakkinda Aydinlatma Metni",
    "privacy.controller": "Veri sorumlusu: {station}. Bu terminali kullanarak asagida aciklanan kapsamda kisisel verilerinizin islenmesini kabul etmis olursunuz; sorulariniz icin istasyon yetkilisine basvurabilirsiniz.",
    "privacy.dataHeading": "Islenen Kisisel Veriler",
    "privacy.dataBody": "Arac plakasi (zorunlu), tercihe bagli olarak e-posta adresi ve/veya telefon numarasi (yalnizca makbuz gonderimi talep ederseniz), islem tutari/miktar/tarih bilgileri.",
    "privacy.purposeHeading": "Isleme Amaclari",
    "privacy.purposeBody": "Yakit satisi sozlesmesinin kurulmasi ve ifasi, odeme islemenin gerceklestirilmesi, e-fatura/e-arsiv duzenlenmesi (Vergi Usul Kanunu geregi yasal yukumluluk), talep etmeniz halinde makbuzun e-posta/SMS ile iletilmesi, sadakat puani takibi.",
    "privacy.recipientsHeading": "Aktarilan Taraflar",
    "privacy.recipientsBody": "Odeme islemi icin iyzico (odeme kurulusu); e-fatura/e-arsiv/e-irsaliye duzenlenmesi icin Uyumsoft (yetkili e-donusum entegratoru). Verileriniz baska bir ticari amacla ucuncu taraflarla paylasilmaz.",
    "privacy.retentionHeading": "Saklama Suresi",
    "privacy.retentionBody": "Fatura/muhasebe kayitlari Vergi Usul Kanunu geregi 10 yil saklanir; diger veriler islem amaci sona erdiginde makul bir surede silinir.",
    "privacy.rightsHeading": "Haklariniz (KVKK md. 11)",
    "privacy.rightsBody": "Verilerinizin islenip islenmedigini ogrenme, islenmisse buna iliskin bilgi talep etme, duzeltilmesini veya silinmesini isteme ve bu islemlerin aktarildigi taraflara bildirilmesini isteme haklarina sahipsiniz. Bu haklari kullanmak icin istasyon yetkilisine yazili basvuruda bulunabilirsiniz.",
    "privacy.close": "Kapat",
  },
  en: {
    "loading": "Loading...",
    "stationNotFound.title": "Station Not Found",
    "stationNotFound.hint": "This kiosk terminal's address may be incorrect. Please contact your station manager.",
    "error.stationLoadFailed": "Could not load station.",
    "error.transactionCreateFailed": "Could not create transaction.",
    "error.paymentInfoLoadFailed": "Could not retrieve transaction info after payment. Please start a new transaction.",
    "creating.hint": "Reserving the pump and redirecting you to the payment screen...",
    "iyzicoWait.title": "Waiting for Payment Result",
    "iyzicoWait.hint": "Verifying your iyzico payment result, please wait...",

    "fuel.benzin": "Gasoline",
    "fuel.motorin": "Diesel",
    "fuel.lpg": "LPG",
    "pumpStatus.idle": "Available",
    "pumpStatus.reserved": "Reserved",
    "pumpStatus.dispensing": "Dispensing",
    "pumpStatus.fault": "Fault",
    "pumpStatus.offline": "Offline",
    "transactionStatus.created": "Created",
    "transactionStatus.paid": "Paid",
    "transactionStatus.authorized": "Authorized",
    "transactionStatus.dispensing": "Dispensing",
    "transactionStatus.completed": "Completed",
    "transactionStatus.cancelled": "Cancelled",
    "transactionStatus.failed": "Failed",

    "plate.title": "Welcome",
    "plate.subtitle": "Enter your license plate to begin, or scan it with automatic plate recognition (LPR).",
    "plate.label": "License Plate",
    "plate.placeholder": "06 ABC 123",
    "plate.lprFailed": "Could not read the plate clearly, please enter it manually.",
    "plate.invalid": "Please enter a valid license plate (e.g. 06 ABC 123).",
    "plate.scanning": "Scanning camera...",
    "plate.scanButton": "Auto-Scan with LPR",
    "plate.continue": "Continue",
    "plate.lprNote": "Note: LPR scanning is simulated in this environment since no physical camera hardware is present.",
    "action.back": "Back",

    "pump.title": "Select a Pump",
    "pump.subtitle": "Please select the available pump your vehicle is at.",

    "fuelStep.title": "Select Fuel Type",
    "fuelStep.subtitle": "Fuel types supported by {pump}.",
    "fuelStep.outOfStockTitle": "This fuel type is currently out of stock.",
    "fuelStep.outOfStock": "Out of Stock",
    "fuelStep.perLiter": "{price} / L",

    "amount.title": "Select Amount",
    "amount.modeAmount": "Enter Amount",
    "amount.modeLiters": "Enter Liters",
    "amount.modeFullTank": "Fill the Tank",
    "amount.customAmountLabel": "Custom amount (TL)",
    "amount.litersLabel": "Liters",
    "amount.estimatedTotal": "Estimated total: {amount}",
    "amount.fullTankHint": "Filling stops automatically when the tank-full sensor is triggered. A maximum estimated amount is shown beforehand.",
    "amount.useLoyalty": "Use my loyalty points ({points} pts = {value} discount)",
    "amount.discountCodeLabel": "Discount Code (optional)",
    "amount.discountCodePlaceholder": "e.g. SUMMER2026",
    "amount.checkingCode": "Checking...",
    "amount.applyCode": "Apply",
    "error.codeInvalid": "Could not validate code.",
    "amount.codeApplied": "\"{code}\" applied: -{amount}",
    "amount.estimatedCharge": "Estimated amount due: {amount}",
    "amount.invalidAmount": "Please enter a valid amount.",
    "amount.invalidLiters": "Please enter a valid liter amount.",
    "action.continue": "Continue",

    "payment.iyzicoTitle": "Secure Payment (iyzico)",
    "payment.discountApplied": "Discount applied: -{discount} (original amount: {total})",
    "payment.estimateNote": "This is an estimate; the final amount is set once filling is complete.",
    "payment.iyzicoSecureNote": "Your card details are entered directly on iyzico's secure payment page, not on this kiosk.",
    "payment.cancel": "Cancel Transaction",
    "payment.payWithCard": "Pay with Card",
    "payment.preparingForm": "Preparing payment form...",
    "error.iyzicoStartFailed": "Could not start the iyzico payment form.",
    "payment.simulatedTitle": "Virtual Payment",
    "payment.cardHolderLabel": "Cardholder Name",
    "payment.cardNumberLabel": "Card Number",
    "payment.monthLabel": "Month",
    "payment.yearLabel": "Year",
    "payment.cvvLabel": "CVV",
    "payment.confirm": "Confirm Payment",
    "payment.processing": "Processing payment...",
    "error.paymentRejected": "Payment declined.",
    "error.paymentFailed": "An error occurred during payment.",
    "payment.simulationNote": "This is a simulated virtual payment; no real bank connection is made.",

    "dispense.authorizing": "Authorizing Pump...",
    "dispense.inProgress": "Filling in Progress",
    "dispense.plateAndPump": "Plate: {plate} — Pump #{pump}",
    "dispense.amountLabel": "Amount Dispensed",
    "dispense.currentTotalLabel": "Current Total",
    "dispense.waitNote": "Please wait, the transaction will finish automatically once filling completes. Status: {status}",

    "receipt.failedTitle": "Transaction Failed",
    "receipt.completedTitle": "Transaction Complete",
    "receipt.cancelledDefault": "Transaction was cancelled.",
    "receipt.successNote": "Your vehicle has been successfully refueled.",
    "receipt.tankFullNote": "The transaction was limited to {liters} because the tank ran out during filling. Thank you for your understanding.",
    "receipt.plate": "Plate",
    "receipt.fuel": "Fuel",
    "receipt.amount": "Amount",
    "receipt.pricePerLiter": "Price per Liter",
    "receipt.fuelValue": "Fuel Value",
    "receipt.discount": "Discount",
    "receipt.chargedAmount": "Amount Charged",
    "receipt.totalAmount": "Total Amount",
    "receipt.pointsEarned": "Points Earned",
    "receipt.transactionNo": "Transaction No",
    "receipt.date": "Date",
    "receipt.restart": "Start New Transaction",
    "receipt.sendReceiptTitle": "Send Receipt",
    "receipt.emailLabel": "Email (optional)",
    "receipt.emailPlaceholder": "example@email.com",
    "receipt.phoneLabel": "Phone (optional)",
    "receipt.phonePlaceholder": "+90 5xx xxx xx xx",
    "receipt.emailSent": "Email sent.",
    "receipt.emailFailed": "Email could not be sent: {reason}",
    "receipt.smsSent": "SMS sent.",
    "receipt.smsFailed": "SMS could not be sent: {reason}",
    "receipt.sentGeneric": "Receipt sent.",
    "error.receiptSendFailed": "Could not send receipt.",
    "receipt.sending": "Sending...",
    "receipt.send": "Send",

    "idle.title": "Are you still there?",
    "idle.body": "No activity has been detected for a while. This transaction will be reset in {seconds} seconds.",
    "idle.continue": "I'm Still Here",

    "privacy.linkLabel": "About the Protection of Personal Data",
    "privacy.title": "Personal Data Protection Notice",
    "privacy.controller": "Data controller: {station}. By using this terminal, you acknowledge the processing of your personal data as described below; please contact the station staff with any questions.",
    "privacy.dataHeading": "Personal Data Processed",
    "privacy.dataBody": "Vehicle license plate (required), and if you request a receipt, your email address and/or phone number (optional), plus transaction amount/quantity/date details.",
    "privacy.purposeHeading": "Purposes of Processing",
    "privacy.purposeBody": "Establishing and performing the fuel sale, processing payment, issuing an e-invoice/e-archive invoice (a legal obligation under Turkish tax law), sending a receipt by email/SMS if requested, and tracking loyalty points.",
    "privacy.recipientsHeading": "Recipients",
    "privacy.recipientsBody": "iyzico (payment institution) for payment processing; Uyumsoft (authorized e-transformation integrator) for issuing e-invoices/e-archive invoices/e-waybills. Your data is not shared with any other third party for commercial purposes.",
    "privacy.retentionHeading": "Retention Period",
    "privacy.retentionBody": "Invoice/accounting records are retained for 10 years as required by Turkish tax law; other data is deleted within a reasonable time once its purpose has been fulfilled.",
    "privacy.rightsHeading": "Your Rights",
    "privacy.rightsBody": "You have the right to learn whether your data is processed, request information about it, request correction or deletion, and request that these actions be notified to third parties it was shared with. You may exercise these rights by submitting a written request to the station staff.",
    "privacy.close": "Close",
  },
};

interface KioskLangState {
  lang: KioskLang;
  setLang: (l: KioskLang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
}

const KioskLangContext = createContext<KioskLangState | null>(null);

const STORAGE_KEY = "kiosk_lang";

export function KioskLangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<KioskLang>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === "en" ? "en" : "tr";
    } catch {
      return "tr";
    }
  });

  function setLang(l: KioskLang) {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // localStorage erisilemez olabilir (ozel gezinti vb.) - dil secimi bu oturumda gecerli kalir.
    }
  }

  function t(key: string, vars?: Record<string, string | number>): string {
    let str = DICTS[lang][key] ?? DICTS.tr[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.split(`{${k}}`).join(String(v));
      }
    }
    return str;
  }

  const locale = lang === "en" ? "en-US" : "tr-TR";

  return <KioskLangContext.Provider value={{ lang, setLang, t, locale }}>{children}</KioskLangContext.Provider>;
}

export function useKioskLang(): KioskLangState {
  const ctx = useContext(KioskLangContext);
  if (!ctx) throw new Error("useKioskLang, KioskLangProvider icinde kullanilmalidir.");
  return ctx;
}

export function LanguageSwitcher() {
  const { lang, setLang } = useKioskLang();
  return (
    <div className="kiosk-lang-switcher">
      <button type="button" className={lang === "tr" ? "active" : ""} onClick={() => setLang("tr")}>
        TR
      </button>
      <button type="button" className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
        EN
      </button>
    </div>
  );
}
