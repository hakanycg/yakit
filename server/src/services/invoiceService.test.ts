import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, TransactionRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { setInvoiceConfig } from "./invoiceSettingsService.js";
import { createInvoice, InvoiceError, VAT_RATE } from "./invoiceService.js";

let station: StationRow;
let actor: UserRow;

function configureProvider(): void {
  setInvoiceConfig(
    station.id,
    { enabled: true, environment: "sandbox", username: "kullanici", password: "sifre", companyVkn: "1234567890", companyTitle: "Test Akaryakit A.S." },
    actor
  );
}

function completedSale(overrides: Partial<{ totalAmount: number; discountAmount: number; dispensedLiters: number }> = {}): TransactionRow {
  const { totalAmount = 500, discountAmount = 0, dispensedLiters = 10 } = overrides;
  const pumpId = createTestPump(station.id);
  const id = db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
          total_amount, discount_amount, payment_method, payment_status, status, kiosk_access_token, completed_at)
       VALUES (?, ?, '34ABC123', 'motorin', 'amount', 50, ?, ?, ?, 'iyzico', 'captured', 'completed', ?, ?)`
    )
    .run(station.id, pumpId, dispensedLiters, totalAmount, discountAmount, `tok-${Math.random()}`, new Date().toISOString())
    .lastInsertRowid as number;
  return db.prepare<[number], TransactionRow>("SELECT * FROM transactions WHERE id = ?").get(id)!;
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "super_admin");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createInvoice", () => {
  it("saglayici baglanmamis istasyonda hic fetch cagirmadan hata firlatir", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createInvoice(completedSale())).rejects.toThrow(InvoiceError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tamamlanmamis islem icin (saglayici hazir olsa bile) hata firlatir", async () => {
    configureProvider();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const t = completedSale();
    await expect(createInvoice({ ...t, status: "dispensing" })).rejects.toThrow("Yalnizca tamamlanmis islemler icin fatura kesilebilir.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("basarili yanitta saglayicinin dondurdugu fatura kimligini dondurur", async () => {
    configureProvider();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ Success: true, InvoiceId: "UYM-1" }) }) as unknown as Response));

    const result = await createInvoice(completedSale());
    expect(result.providerInvoiceId).toBe("UYM-1");
  });

  it("KDV dahil tutari dogru ayristirir: KDV'siz tutar + KDV tutari = tahsil edilen tutar", async () => {
    configureProvider();
    let sentBody: {
      Invoice: {
        InvoiceLine: [{ InvoicedQuantity: number; TaxTotal: { TaxAmount: number; Percent: number } }];
        LegalMonetaryTotal: { TaxExclusiveAmount: number; TaxInclusiveAmount: number; PayableAmount: number };
      };
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(init.body as string);
        return { ok: true, status: 200, json: async () => ({ Success: true, InvoiceId: "UYM-1" }) } as unknown as Response;
      })
    );

    // total 600, indirim 100 -> tahsil edilen 500 (KDV dahil)
    await createInvoice(completedSale({ totalAmount: 600, discountAmount: 100, dispensedLiters: 10 }));

    const line = sentBody!.Invoice.InvoiceLine[0];
    const total = sentBody!.Invoice.LegalMonetaryTotal;
    expect(total.TaxInclusiveAmount).toBe(500);
    expect(total.PayableAmount).toBe(500);
    // KDV'siz tutar + KDV tutari, KDV dahil tutara esit olmali (yuvarlama farki olmadan)
    expect(Math.round((total.TaxExclusiveAmount + line.TaxTotal.TaxAmount) * 100) / 100).toBe(500);
    expect(line.TaxTotal.Percent).toBe(VAT_RATE * 100);
    expect(line.InvoicedQuantity).toBe(10);
  });

  it("indirim tutari toplam tutari asarsa (negatif olamaz) tahsilat sifir kabul edilir", async () => {
    configureProvider();
    let sentBody: { Invoice: { LegalMonetaryTotal: { TaxInclusiveAmount: number } } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(init.body as string);
        return { ok: true, status: 200, json: async () => ({ Success: true, InvoiceId: "UYM-1" }) } as unknown as Response;
      })
    );

    await createInvoice(completedSale({ totalAmount: 100, discountAmount: 150 }));
    expect(sentBody!.Invoice.LegalMonetaryTotal.TaxInclusiveAmount).toBe(0);
  });

  it("saglayiciya baglanti kurulamazsa 502 InvoiceError firlatir", async () => {
    configureProvider();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    const err = await createInvoice(completedSale()).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("saglayici HTTP hatasi dondururse status kodunu iceren bir hata firlatir", async () => {
    configureProvider();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => null }) as unknown as Response));

    const err = await createInvoice(completedSale()).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceError);
    expect(err.message).toContain("500");
  });

  it("saglayici Success:false donerse ErrorMessage'i yansitan bir hata firlatir", async () => {
    configureProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ Success: false, ErrorMessage: "VKN gecersiz" }) }) as unknown as Response)
    );

    await expect(createInvoice(completedSale())).rejects.toThrow("VKN gecersiz");
  });

  it("saglayici gecersiz/bos yanit donerse genel bir hata firlatir", async () => {
    configureProvider();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => null }) as unknown as Response));

    await expect(createInvoice(completedSale())).rejects.toThrow(InvoiceError);
  });
});
