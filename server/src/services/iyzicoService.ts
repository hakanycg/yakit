import { createHmac, timingSafeEqual } from "node:crypto";
import Iyzipay from "iyzipay";
import { getIyzicoConfig, iyzicoBaseUrl, isIyzicoReady } from "./paymentSettingsService.js";

export class IyzicoError extends Error {
  constructor(
    message: string,
    public status = 502
  ) {
    super(message);
  }
}

function getClient(stationId: number): { client: Iyzipay; secretKey: string } {
  const config = getIyzicoConfig(stationId);
  if (!config.apiKey || !config.secretKey) {
    throw new IyzicoError("iyzico API anahtarlari tanimlanmamis.", 409);
  }
  const client = new Iyzipay({
    apiKey: config.apiKey,
    secretKey: config.secretKey,
    uri: iyzicoBaseUrl(config.environment),
  });
  return { client, secretKey: config.secretKey };
}

/** iyzico'nun HMAC-SHA256 imzasini dogrular (bkz. iyzico dokumantasyonu: signature verification). */
function verifySignature(params: (string | undefined)[], secretKey: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secretKey).update(params.map((p) => p ?? "").join(":")).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface InitCheckoutFormInput {
  stationId: number;
  transactionId: number;
  totalAmount: number;
  plate: string;
  fuelLabel: string;
  ip: string;
  callbackUrl: string;
  /**
   * true ise ON-PROVIZYON (pre-auth/hold) baslatilir: kart, totalAmount kadar BLOKE edilir
   * ama TAHSIL EDILMEZ. "Depoyu Doldur" gibi gercek tutarin dolum bitmeden bilinemedigi
   * durumlarda kullanilir - musteri, dolum bitip capturePostAuth() cagrilana kadar kartindan
   * hicbir sey odememis olur (bkz. capturePostAuth, cancelPreAuthHold). false/verilmezse
   * (varsayilan), tutar aninda tahsil edilir - miktari onceden kesin bilinen (amount/liters
   * modu) islemler icin dogru davranis budur.
   */
  preAuth?: boolean;
}

export interface InitCheckoutFormResult {
  token: string;
  checkoutFormContent: string;
  paymentPageUrl?: string;
}

/**
 * iyzico Checkout Form (odeme formu) baslatir. Kiosk'ta kart bilgisi toplanmaz;
 * musteri iyzico'nun barindirdigi guvenli odeme sayfasina yonlendirilir (PCI DSS
 * kapsamı iyzico tarafinda kalir). Sonuc, iyzico'nun sunucudan sunucuya gonderdigi
 * callback ile dogrulanir (bkz. iyzicoService.retrieveCheckoutForm).
 */
export function initializeCheckoutForm(input: InitCheckoutFormInput): Promise<InitCheckoutFormResult> {
  const readiness = isIyzicoReady(input.stationId);
  if (!readiness.ready) {
    throw new IyzicoError(readiness.reason ?? "iyzico kullanima hazir degil.", 409);
  }

  const { client, secretKey } = getClient(input.stationId);
  const price = input.totalAmount.toFixed(2);

  const request = {
    locale: Iyzipay.LOCALE.TR,
    conversationId: String(input.transactionId),
    price,
    paidPrice: price,
    currency: Iyzipay.CURRENCY.TRY,
    basketId: `TX-${input.transactionId}`,
    paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
    callbackUrl: input.callbackUrl,
    enabledInstallments: [1],
    buyer: {
      id: `kiosk-tx-${input.transactionId}`,
      name: "Kiosk",
      surname: "Musteri",
      gsmNumber: "+905000000000",
      // NOT: ".local" gecerli/kayit edilebilir bir TLD degildir (RFC 6762 - yerel ag/mDNS
      // icin ayrilmis sozde bir uzanti); iyzico bunu gecersiz e-posta formati olarak
      // reddediyordu ("email hatali format ile gonderilmistir"). Kiosk'ta gercek musteri
      // e-postasi odemeden ONCE toplanmadigi icin (makbuz adiminda, odemeden SONRA
      // opsiyonel olarak istenir), burada gecerli FORMATTA sabit bir yer tutucu kullanilir.
      email: "kiosk-musteri@yakit-istasyonu.com",
      identityNumber: "11111111111",
      lastLoginDate: new Date().toISOString().replace("T", " ").slice(0, 19),
      registrationDate: new Date().toISOString().replace("T", " ").slice(0, 19),
      registrationAddress: "Akaryakit istasyonu self-servis kiosk",
      ip: input.ip,
      city: "Istanbul",
      country: "Turkey",
      zipCode: "34000",
    },
    shippingAddress: {
      contactName: "Kiosk Musteri",
      city: "Istanbul",
      country: "Turkey",
      address: "Akaryakit istasyonu self-servis kiosk",
      zipCode: "34000",
    },
    billingAddress: {
      contactName: "Kiosk Musteri",
      city: "Istanbul",
      country: "Turkey",
      address: "Akaryakit istasyonu self-servis kiosk",
      zipCode: "34000",
    },
    basketItems: [
      {
        id: `FUEL-${input.transactionId}`,
        name: `${input.fuelLabel} - Plaka ${input.plate}`,
        category1: "Akaryakit",
        itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL,
        price,
      },
    ],
  };

  const resource = input.preAuth ? client.checkoutFormInitializePreAuth : client.checkoutFormInitialize;

  return new Promise((resolve, reject) => {
    resource.create(request, (err, result) => {
      if (err) return reject(new IyzicoError(`iyzico baglanti hatasi: ${err.message}`, 502));
      if (result.status !== "success" || !result.token || !result.checkoutFormContent) {
        return reject(new IyzicoError(result.errorMessage ?? "iyzico odeme formu baslatilamadi.", 502));
      }
      if (!verifySignature([result.conversationId, result.token], secretKey, result.signature)) {
        return reject(new IyzicoError("iyzico yanit imzasi dogrulanamadi.", 502));
      }
      resolve({
        token: result.token,
        checkoutFormContent: result.checkoutFormContent,
        paymentPageUrl: result.paymentPageUrl,
      });
    });
  });
}

export interface RetrieveResult {
  success: boolean;
  conversationId: string | null;
  paymentId: string | null;
  paidPrice: number | null;
  message: string;
}

/** iyzico callback'inde gelen token'i sunucu-sunucu sorgusuyla dogrular; callback body'sindeki degerlere guvenilmez. */
export function retrieveCheckoutForm(stationId: number, token: string): Promise<RetrieveResult> {
  const { client, secretKey } = getClient(stationId);
  const request = { locale: Iyzipay.LOCALE.TR, token };

  return new Promise((resolve, reject) => {
    client.checkoutForm.retrieve(request, (err, result) => {
      if (err) return reject(new IyzicoError(`iyzico dogrulama hatasi: ${err.message}`, 502));
      if (result.status !== "success") {
        return resolve({
          success: false,
          conversationId: result.conversationId ?? null,
          paymentId: null,
          paidPrice: null,
          message: result.errorMessage ?? "iyzico odeme dogrulanamadi.",
        });
      }
      if (
        !verifySignature(
          [result.paymentStatus, result.paymentId, result.currency, result.basketId, result.conversationId, result.paidPrice, result.price, result.token],
          secretKey,
          result.signature
        )
      ) {
        return reject(new IyzicoError("iyzico yanit imzasi dogrulanamadi.", 502));
      }
      const paid = result.paymentStatus === "SUCCESS";
      resolve({
        success: paid,
        conversationId: result.conversationId ?? null,
        paymentId: result.paymentId ?? null,
        paidPrice: result.paidPrice ? Number(result.paidPrice) : null,
        message: paid ? "Odeme onaylandi." : `Odeme basarisiz (${result.paymentStatus ?? "bilinmiyor"}).`,
      });
    });
  });
}

export interface RefundResult {
  refundId: string;
}

/**
 * TAHSIL EDILMIS bir odemenin tamamini veya bir kismini iade eder.
 *
 * capturePostAuth'tan farkli bir sey yapar: orada bloke edilen ama tahsil edilmeyen kisim
 * bankada kendiliginden serbest kalir. Burada ise para MUSTERIDEN CIKMISTIR ve geri
 * gonderilmesi gerekir - iyzico'nun refund ucu bunun icindir.
 *
 * Kismi iade desteklenir: 50 L'lik bir tahsilatin 30 L'lik kismi iade edilebilir.
 */
export function refundPayment(
  stationId: number,
  transactionId: number,
  paymentTransactionId: string,
  amount: number,
  ip?: string
): Promise<RefundResult> {
  const { client, secretKey } = getClient(stationId);
  const request = {
    locale: Iyzipay.LOCALE.TR,
    conversationId: String(transactionId),
    paymentTransactionId,
    price: amount.toFixed(2),
    currency: Iyzipay.CURRENCY.TRY,
    ip: ip ?? "127.0.0.1",
  };

  return new Promise((resolve, reject) => {
    client.refund.create(request, (err, result) => {
      if (err) return reject(new IyzicoError(`iyzico iade baglanti hatasi: ${err.message}`, 502));
      if (result.status !== "success") {
        return reject(new IyzicoError(result.errorMessage ?? "iyzico iade islemi basarisiz.", 502));
      }
      // Yanit imzasi dogrulanir: iade tutarinin ve kimliginin gercekten iyzico'dan
      // geldigini teyit etmeden kayda gecirmek, cevaba kosulsuz guvenmek olurdu
      // (ayni gerekce: odeme callback'inde imza dogrulamasi).
      if (
        !verifySignature(
          [result.paymentId, result.price, result.currency, result.conversationId],
          secretKey,
          result.signature
        )
      ) {
        return reject(new IyzicoError("iyzico iade yaniti imzasi dogrulanamadi.", 502));
      }
      resolve({ refundId: String(result.paymentTransactionId ?? result.paymentId) });
    });
  });
}

export interface SettlementResult {
  success: boolean;
  message: string;
}

/**
 * On-provizyon (pre-auth) ile tutulan bir odemeyi, dolum bitip GERCEK tutar belli olunca
 * kapatir (capture). Yalnizca `paidPrice` kadari tahsil edilir; bloke edilenin geri kalani
 * bankada otomatik serbest kalir - ayrica bir iade (refund) cagrisina gerek yoktur.
 */
export function capturePostAuth(stationId: number, transactionId: number, paymentId: string, paidPrice: number): Promise<SettlementResult> {
  const { client, secretKey } = getClient(stationId);
  const price = paidPrice.toFixed(2);
  const request = {
    locale: Iyzipay.LOCALE.TR,
    conversationId: String(transactionId),
    paymentId,
    paidPrice: price,
    currency: Iyzipay.CURRENCY.TRY,
  };

  return new Promise((resolve, reject) => {
    client.paymentPostAuth.create(request, (err, result) => {
      if (err) return reject(new IyzicoError(`iyzico post-auth baglanti hatasi: ${err.message}`, 502));
      if (result.status !== "success") {
        return reject(new IyzicoError(result.errorMessage ?? "iyzico post-auth (kapama) basarisiz.", 502));
      }
      if (
        !verifySignature(
          [result.paymentId, result.currency, result.basketId, result.conversationId, result.paidPrice, result.price],
          secretKey,
          result.signature
        )
      ) {
        return reject(new IyzicoError("iyzico post-auth yaniti imzasi dogrulanamadi.", 502));
      }
      resolve({ success: true, message: "Odeme gercek tutar uzerinden kapatildi." });
    });
  });
}

/**
 * Hic dolum gerceklesmeden (0 litre) islem iptal olursa, on-provizyonla tutulan blokajin
 * TAMAMINI sifir tahsilatla serbest birakir - musterinin kartindan hicbir sey cekilmemis olur.
 */
export function cancelPreAuthHold(stationId: number, transactionId: number, paymentId: string): Promise<SettlementResult> {
  const { client } = getClient(stationId);
  const request = {
    locale: Iyzipay.LOCALE.TR,
    conversationId: String(transactionId),
    paymentId,
    ip: "127.0.0.1",
  };

  return new Promise((resolve, reject) => {
    client.cancel.create(request, (err, result) => {
      if (err) return reject(new IyzicoError(`iyzico iptal baglanti hatasi: ${err.message}`, 502));
      if (result.status !== "success") {
        return reject(new IyzicoError(result.errorMessage ?? "iyzico on-provizyon iptali basarisiz.", 502));
      }
      // NOT: iyzico'nun resmi dokumantasyonuna bu ortamdan (ag erisimi engelli) ulasilamadi;
      // SDK'nin kendi ornek testlerinde de cancel.create() icin bir imza dogrulamasi
      // gosterilmiyor (checkoutForm.retrieve/paymentPostAuth'un aksine). Bu yuzden burada
      // ispatlanmamis bir imza alan sirasi UYDURMAK yerine, en azindan istenen paymentId ile
      // donen paymentId'nin eslesip eslesmedigi kontrol ediliyor. Gercek bir iyzico sandbox
      // ortaminda canli test edilip, eger yanit gercekten bir `signature` alani iceriyorsa
      // dogru alan sirasiyla tam imza dogrulamasi buraya eklenmelidir.
      if (result.paymentId && String(result.paymentId) !== paymentId) {
        return reject(new IyzicoError("iyzico iptal yaniti beklenmeyen paymentId ile geldi.", 502));
      }
      resolve({ success: true, message: "On-provizyon blokaji tamamen serbest birakildi." });
    });
  });
}
