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
      email: "kiosk-musteri@yakit-istasyonu.local",
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

  return new Promise((resolve, reject) => {
    client.checkoutFormInitialize.create(request, (err, result) => {
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
