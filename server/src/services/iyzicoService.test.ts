import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../config.js";
import type { StationRow } from "../db/types.js";
import { createTestStation } from "../test/dbFixture.js";
import { setIyzicoConfig } from "./paymentSettingsService.js";

/**
 * iyzicoService.ts, iyzipay npm paketinin KENDISINI kullanir (gercek ag cagrisi
 * YOK - refundService.test.ts'in TERSI: orada iyzicoService mock'lanir, burada
 * iyzicoService'in kendisi test edilir). Mock, gercek Iyzipay sinifinin (bkz.
 * types/iyzipay.d.ts) statik alanlarini (LOCALE, CURRENCY, ...) ve kullanilan
 * kaynaklarin (checkoutFormInitialize, checkoutForm, refund, paymentPostAuth,
 * cancel) sekillerini birebir yansitir.
 */
const createMock = vi.fn();
const retrieveMock = vi.fn();
const refundCreateMock = vi.fn();
const postAuthCreateMock = vi.fn();
const cancelCreateMock = vi.fn();

vi.mock("iyzipay", () => {
  class MockIyzipay {
    static LOCALE = { TR: "tr", EN: "en" };
    static CURRENCY = { TRY: "TRY", USD: "USD", EUR: "EUR", GBP: "GBP" };
    static PAYMENT_GROUP = { PRODUCT: "PRODUCT", LISTING: "LISTING", SUBSCRIPTION: "SUBSCRIPTION" };
    static BASKET_ITEM_TYPE = { PHYSICAL: "PHYSICAL", VIRTUAL: "VIRTUAL" };
    static REFUND_REASON = { DOUBLE_PAYMENT: "double_payment", BUYER_REQUEST: "buyer_request", FRAUD: "fraud", OTHER: "other" };

    checkoutFormInitialize = { create: createMock };
    checkoutFormInitializePreAuth = { create: createMock };
    checkoutForm = { retrieve: retrieveMock };
    refund = { create: refundCreateMock };
    paymentPostAuth = { create: postAuthCreateMock };
    cancel = { create: cancelCreateMock };
  }
  return { default: MockIyzipay };
});

const { initializeCheckoutForm, retrieveCheckoutForm, refundPayment, capturePostAuth, cancelPreAuthHold, IyzicoError } = await import(
  "./iyzicoService.js"
);

const SECRET_KEY = "test-secret-key";
let station: StationRow;
let previousPublicApiBaseUrl: string | undefined;

/** Ayni algoritma (HMAC-SHA256, ':' ile birlesitirme) BAGIMSIZ olarak burada hesaplanir -
 * iyzicoService.ts'in ozel (export edilmemis) verifySignature'ini dogrudan cagirmiyoruz,
 * boylece "gecerli" bir imzanin gercekten koda gore GECERLI oldugunu (tautoloji degil)
 * kanitlariz. */
function sign(params: (string | undefined)[]): string {
  return createHmac("sha256", SECRET_KEY).update(params.map((p) => p ?? "").join(":")).digest("hex");
}

beforeEach(() => {
  station = createTestStation();
  setIyzicoConfig(station.id, { enabled: true, environment: "sandbox", apiKey: "test-api-key", secretKey: SECRET_KEY }, null);
  createMock.mockReset();
  retrieveMock.mockReset();
  refundCreateMock.mockReset();
  postAuthCreateMock.mockReset();
  cancelCreateMock.mockReset();
  previousPublicApiBaseUrl = env.PUBLIC_API_BASE_URL;
  env.PUBLIC_API_BASE_URL = "https://ops.example.com";
});

afterEach(() => {
  env.PUBLIC_API_BASE_URL = previousPublicApiBaseUrl;
});

const baseInput = () => ({
  stationId: station.id,
  transactionId: 42,
  totalAmount: 150.5,
  plate: "34ABC34",
  fuelLabel: "Motorin",
  ip: "127.0.0.1",
  callbackUrl: "https://ops.example.com/callback",
});

describe("initializeCheckoutForm", () => {
  it("gecerli imzali yaniti kabul eder", async () => {
    createMock.mockImplementation((_req, cb) => {
      const result = { status: "success", conversationId: "42", token: "tok-1", checkoutFormContent: "<div/>" };
      cb(null, { ...result, signature: sign([result.conversationId, result.token]) });
    });

    const res = await initializeCheckoutForm(baseInput());
    expect(res.token).toBe("tok-1");
  });

  it("KURCALANMIS (bozuk) imzali yaniti REDDEDER", async () => {
    createMock.mockImplementation((_req, cb) => {
      cb(null, { status: "success", conversationId: "42", token: "tok-1", checkoutFormContent: "<div/>", signature: "0000deadbeef" });
    });

    await expect(initializeCheckoutForm(baseInput())).rejects.toThrow(IyzicoError);
  });

  it("saglayici baglanti hatasi verirse 502 ile hata firlatir", async () => {
    createMock.mockImplementation((_req, cb) => cb(new Error("ECONNREFUSED"), undefined));

    await expect(initializeCheckoutForm(baseInput())).rejects.toMatchObject({ status: 502 });
  });

  it("result.status basarisizsa saglayicinin errorMessage'iyla hata firlatir", async () => {
    createMock.mockImplementation((_req, cb) => cb(null, { status: "failure", errorMessage: "Gecersiz kart." }));

    await expect(initializeCheckoutForm(baseInput())).rejects.toThrow("Gecersiz kart.");
  });

  it("API anahtarlari tanimlanmamis istasyonda 409 ile hata firlatir, saglayiciya hic gitmez", async () => {
    const bareStation = createTestStation();
    setIyzicoConfig(bareStation.id, { enabled: true, environment: "sandbox" }, null);

    // initializeCheckoutForm senkron olarak (Promise'e girmeden ONCE) firlatir - bu yuzden
    // cagriyi bir async fonksiyona sarip .rejects ile bekliyoruz.
    await expect((async () => initializeCheckoutForm({ ...baseInput(), stationId: bareStation.id }))()).rejects.toMatchObject({
      status: 409,
    });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("retrieveCheckoutForm", () => {
  it("gecerli imzali basarili odemeyi kabul eder", async () => {
    retrieveMock.mockImplementation((_req, cb) => {
      const result = {
        status: "success",
        paymentStatus: "SUCCESS",
        paymentId: "pay-1",
        currency: "TRY",
        basketId: "TX-42",
        conversationId: "42",
        paidPrice: "150.50",
        price: "150.50",
        token: "tok-1",
      };
      cb(null, { ...result, signature: sign([result.paymentStatus, result.paymentId, result.currency, result.basketId, result.conversationId, result.paidPrice, result.price, result.token]) });
    });

    const res = await retrieveCheckoutForm(station.id, "tok-1");
    expect(res).toMatchObject({ success: true, paymentId: "pay-1" });
  });

  it("KURCALANMIS imzali yaniti REDDEDER (odeme onaylanmis gibi kaydedilmez)", async () => {
    retrieveMock.mockImplementation((_req, cb) => {
      cb(null, {
        status: "success",
        paymentStatus: "SUCCESS",
        paymentId: "pay-1",
        currency: "TRY",
        basketId: "TX-42",
        conversationId: "42",
        paidPrice: "150.50",
        price: "150.50",
        token: "tok-1",
        signature: "kurcalanmis-imza",
      });
    });

    await expect(retrieveCheckoutForm(station.id, "tok-1")).rejects.toThrow(IyzicoError);
  });

  it("saglayici baglanti hatasinda 502 ile hata firlatir", async () => {
    retrieveMock.mockImplementation((_req, cb) => cb(new Error("timeout"), undefined));

    await expect(retrieveCheckoutForm(station.id, "tok-1")).rejects.toMatchObject({ status: 502 });
  });

  it("result.status basarisizsa hata FIRLATMAZ, success:false doner (imza kontrolune girmez)", async () => {
    retrieveMock.mockImplementation((_req, cb) => cb(null, { status: "failure", errorMessage: "Odeme reddedildi.", conversationId: "42" }));

    const res = await retrieveCheckoutForm(station.id, "tok-1");
    expect(res).toMatchObject({ success: false, message: "Odeme reddedildi." });
  });
});

describe("refundPayment", () => {
  it("gecerli imzali iadeyi kabul eder", async () => {
    refundCreateMock.mockImplementation((_req, cb) => {
      const result = { status: "success", paymentId: "pay-1", paymentTransactionId: "ptx-1", price: "50.00", currency: "TRY", conversationId: "42" };
      cb(null, { ...result, signature: sign([result.paymentId, result.price, result.currency, result.conversationId]) });
    });

    const res = await refundPayment(station.id, 42, "ptx-1", 50);
    expect(res.refundId).toBe("ptx-1");
  });

  it("KURCALANMIS imzali iade yanitini REDDEDER", async () => {
    refundCreateMock.mockImplementation((_req, cb) => {
      cb(null, { status: "success", paymentId: "pay-1", paymentTransactionId: "ptx-1", price: "50.00", currency: "TRY", conversationId: "42", signature: "bozuk" });
    });

    await expect(refundPayment(station.id, 42, "ptx-1", 50)).rejects.toThrow(IyzicoError);
  });

  it("saglayici basarisiz donerse hata firlatir", async () => {
    refundCreateMock.mockImplementation((_req, cb) => cb(null, { status: "failure", errorMessage: "Iade limiti asildi." }));

    await expect(refundPayment(station.id, 42, "ptx-1", 50)).rejects.toThrow("Iade limiti asildi.");
  });
});

describe("capturePostAuth", () => {
  it("gecerli imzali kapama (capture) islemini kabul eder", async () => {
    postAuthCreateMock.mockImplementation((_req, cb) => {
      const result = { status: "success", paymentId: "pay-1", currency: "TRY", basketId: "TX-42", conversationId: "42", paidPrice: "80.00", price: "80.00" };
      cb(null, { ...result, signature: sign([result.paymentId, result.currency, result.basketId, result.conversationId, result.paidPrice, result.price]) });
    });

    const res = await capturePostAuth(station.id, 42, "pay-1", 80);
    expect(res.success).toBe(true);
  });

  it("KURCALANMIS imzali kapama yanitini REDDEDER", async () => {
    postAuthCreateMock.mockImplementation((_req, cb) => {
      cb(null, { status: "success", paymentId: "pay-1", currency: "TRY", basketId: "TX-42", conversationId: "42", paidPrice: "80.00", price: "80.00", signature: "bozuk" });
    });

    await expect(capturePostAuth(station.id, 42, "pay-1", 80)).rejects.toThrow(IyzicoError);
  });
});

describe("cancelPreAuthHold", () => {
  // NOT (dosyanin kendi yorumunda da belirtildigi gibi): iyzico'nun resmi dokumantasyonuna
  // bu ortamdan ulasilamadigindan, cancel.create() icin bir imza semasi UYDURULMUYOR. Burada
  // yalnizca kodun ZATEN yaptigi tek kontrol (donen paymentId'nin istenenle eslesmesi) test
  // edilir - bu, kodun dokumante ettigi sinirin OTESINE gecmeden yazilmis dogru bir testtir.
  it("paymentId eslesirse basarili sonuc doner", async () => {
    cancelCreateMock.mockImplementation((_req, cb) => cb(null, { status: "success", paymentId: "pay-1" }));

    const res = await cancelPreAuthHold(station.id, 42, "pay-1");
    expect(res.success).toBe(true);
  });

  it("donen paymentId istenenle ESLESMEZSE hata firlatir", async () => {
    cancelCreateMock.mockImplementation((_req, cb) => cb(null, { status: "success", paymentId: "baska-bir-odeme" }));

    await expect(cancelPreAuthHold(station.id, 42, "pay-1")).rejects.toThrow(IyzicoError);
  });

  it("saglayici basarisiz donerse hata firlatir", async () => {
    cancelCreateMock.mockImplementation((_req, cb) => cb(null, { status: "failure", errorMessage: "Islem bulunamadi." }));

    await expect(cancelPreAuthHold(station.id, 42, "pay-1")).rejects.toThrow("Islem bulunamadi.");
  });
});
