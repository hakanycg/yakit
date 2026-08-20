declare module "iyzipay" {
  interface IyzipayOptions {
    apiKey: string;
    secretKey: string;
    uri: string;
  }

  type IyzipayCallback<T> = (err: Error | null, result: T) => void;

  interface CheckoutFormInitializeResult {
    status: "success" | "failure";
    errorCode?: string;
    errorMessage?: string;
    errorGroup?: string;
    locale?: string;
    systemTime?: number;
    conversationId?: string;
    token?: string;
    checkoutFormContent?: string;
    tokenExpireTime?: number;
    paymentPageUrl?: string;
    signature?: string;
  }

  interface CheckoutFormRetrieveResult {
    status: "success" | "failure";
    errorCode?: string;
    errorMessage?: string;
    errorGroup?: string;
    locale?: string;
    systemTime?: number;
    conversationId?: string;
    token?: string;
    paymentStatus?: "SUCCESS" | "FAILURE" | "INIT_THREEDS" | "CALLBACK_THREEDS" | "BKM_POS_SELECTED" | string;
    paymentId?: string;
    fraudStatus?: number;
    price?: string;
    paidPrice?: string;
    currency?: string;
    basketId?: string;
    binNumber?: string;
    lastFourDigits?: string;
    cardAssociation?: string;
    cardFamily?: string;
    cardType?: string;
    installment?: number;
    signature?: string;
  }

  interface PaymentPostAuthResult {
    status: "success" | "failure";
    errorCode?: string;
    errorMessage?: string;
    errorGroup?: string;
    locale?: string;
    systemTime?: number;
    conversationId?: string;
    paymentId?: string;
    price?: string;
    paidPrice?: string;
    currency?: string;
    basketId?: string;
    signature?: string;
  }

  interface CancelResult {
    status: "success" | "failure";
    errorCode?: string;
    errorMessage?: string;
    errorGroup?: string;
    locale?: string;
    systemTime?: number;
    conversationId?: string;
    paymentId?: string;
    price?: string;
    signature?: string;
  }

  interface CheckoutFormInitializeResource {
    create(request: Record<string, unknown>, callback: IyzipayCallback<CheckoutFormInitializeResult>): void;
  }

  interface CheckoutFormResource {
    retrieve(request: Record<string, unknown>, callback: IyzipayCallback<CheckoutFormRetrieveResult>): void;
  }

  interface PaymentPostAuthResource {
    create(request: Record<string, unknown>, callback: IyzipayCallback<PaymentPostAuthResult>): void;
  }

  interface CancelResource {
    create(request: Record<string, unknown>, callback: IyzipayCallback<CancelResult>): void;
  }

  export default class Iyzipay {
    static LOCALE: { TR: string; EN: string };
    static CURRENCY: { TRY: string; USD: string; EUR: string; GBP: string };
    static PAYMENT_GROUP: { PRODUCT: string; LISTING: string; SUBSCRIPTION: string };
    static BASKET_ITEM_TYPE: { PHYSICAL: string; VIRTUAL: string };
    static REFUND_REASON: { DOUBLE_PAYMENT: string; BUYER_REQUEST: string; FRAUD: string; OTHER: string };

    constructor(options: IyzipayOptions);

    checkoutFormInitialize: CheckoutFormInitializeResource;
    /** Ayni istekle, ama TAHSILAT yerine ON-PROVIZYON (hold) baslatir - bkz. iyzicoService.ts capturePostAuth/cancelPreAuthHold. */
    checkoutFormInitializePreAuth: CheckoutFormInitializeResource;
    checkoutForm: CheckoutFormResource;
    /** On-provizyonu, gercek/nihai tutar uzerinden kapatir (capture). */
    paymentPostAuth: PaymentPostAuthResource;
    /** Bir odemeyi (henuz uzlasmamissa) tamamen iptal eder/serbest birakir - on-provizyon blokajinin sifir tahsilatla iptali dahil. */
    cancel: CancelResource;
  }
}
