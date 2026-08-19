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

  interface CheckoutFormInitializeResource {
    create(request: Record<string, unknown>, callback: IyzipayCallback<CheckoutFormInitializeResult>): void;
  }

  interface CheckoutFormResource {
    retrieve(request: Record<string, unknown>, callback: IyzipayCallback<CheckoutFormRetrieveResult>): void;
  }

  export default class Iyzipay {
    static LOCALE: { TR: string; EN: string };
    static CURRENCY: { TRY: string; USD: string; EUR: string; GBP: string };
    static PAYMENT_GROUP: { PRODUCT: string; LISTING: string; SUBSCRIPTION: string };
    static BASKET_ITEM_TYPE: { PHYSICAL: string; VIRTUAL: string };

    constructor(options: IyzipayOptions);

    checkoutFormInitialize: CheckoutFormInitializeResource;
    checkoutForm: CheckoutFormResource;
  }
}
