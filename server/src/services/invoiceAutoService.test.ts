import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, TransactionRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { setInvoiceConfig } from "./invoiceSettingsService.js";
import { getInvoiceForTransaction } from "./invoiceRecordService.js";
import { issueInvoiceAutomatically } from "./invoiceAutoService.js";

let station: StationRow;
let actor: UserRow;

function configureProvider(): void {
  setInvoiceConfig(
    station.id,
    {
      enabled: true,
      environment: "sandbox",
      username: "kullanici",
      password: "sifre",
      companyVkn: "1234567890",
      companyTitle: "Test Akaryakit A.S.",
    },
    actor
  );
}

function completedSale(amount = 500, discount = 0): TransactionRow {
  const pumpId = createTestPump(station.id);
  const id = db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
          total_amount, discount_amount, payment_method, payment_status, status, kiosk_access_token, completed_at)
       VALUES (?, ?, '34ABC123', 'motorin', 'amount', 50, 10, ?, ?, 'iyzico', 'captured', 'completed', ?, ?)`
    )
    .run(station.id, pumpId, amount, discount, `tok-${Math.random()}`, new Date().toISOString())
    .lastInsertRowid as number;
  return db.prepare<[number], TransactionRow>("SELECT * FROM transactions WHERE id = ?").get(id)!;
}

/** Bir sonraki mikro-gorev turuna kadar bekler: otomatik kesim arka planda calisir. */
const settle = async () => {
  // createInvoice icinde birden fazla await var (fetch, .json()); tek bir tur yetmiyor.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "super_admin");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("issueInvoiceAutomatically", () => {
  it("satis bitince faturayi kendiliginden keser - kimse dugmeye basmadan", async () => {
    configureProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ Success: true, InvoiceId: "UYM-1" }) }) as unknown as Response)
    );

    issueInvoiceAutomatically(completedSale());
    await settle();

    const invoice = getInvoiceForTransaction(
      (db.prepare("SELECT MAX(id) as id FROM transactions").get() as { id: number }).id
    );
    expect(invoice?.status).toBe("sent");
    // Otomatik kesimde ekranin basinda personel yok: uydurma bir kullanici yazilmamali.
    expect(invoice?.created_by).toBeNull();
  });

  it("saglayici hata verirse islemi bozmaz, kaydi 'failed' birakir (panelden yeniden denenebilir)", async () => {
    configureProvider();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("baglanti yok"); }));

    const t = completedSale();
    expect(() => issueInvoiceAutomatically(t)).not.toThrow();
    await settle();

    const invoice = getInvoiceForTransaction(t.id);
    expect(invoice?.status).toBe("failed");
    expect(invoice?.error_message).toContain("baglanti yok");
  });

  it("e-belge entegrasyonu kurulmamis istasyonda saglayiciya hic gitmez", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    issueInvoiceAutomatically(completedSale());
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hicbir sey tahsil edilmemis islem icin fatura kesmez", async () => {
    configureProvider();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // 0 litreyle kapanan bir islem: tutar 0, kesilecek fatura yok.
    issueInvoiceAutomatically(completedSale(0));
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ayni islem icin ikinci kez cagrilirsa fatura tekrar kesilmez", async () => {
    configureProvider();
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({ Success: true, InvoiceId: "UYM-2" }) }) as unknown as Response
    );
    vi.stubGlobal("fetch", fetchMock);

    const t = completedSale();
    issueInvoiceAutomatically(t);
    await settle();
    issueInvoiceAutomatically(t);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tamamlanmamis islem icin fatura kesmez", async () => {
    configureProvider();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const t = completedSale();
    issueInvoiceAutomatically({ ...t, status: "dispensing" });
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
