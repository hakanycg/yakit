import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { createAccount } from "./fleetService.js";
import { setInvoiceConfig } from "./invoiceSettingsService.js";
import {
  FleetInvoiceError,
  createPeriodInvoice,
  getInvoiceDraft,
  listFleetInvoices,
  retryFleetInvoice,
} from "./fleetInvoiceService.js";

let station: StationRow;
let actor: UserRow;
let accountId: number;

/** Saglayici cagrisi: testlerde gercek HTTP atilmaz, fetch degistirilir. */
function mockProvider(response: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => response }) as unknown as Response)
  );
}

function failingProvider(): void {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("baglanti yok"); }));
}

/** Bir yakit alimi + ona bagli tahsilat hareketi. */
function addFill(opts: { plate: string; liters: number; amount: number; at: string; type?: "charge" | "refund" }): number {
  const pumpId = createTestPump(station.id);
  const transactionId = db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
          total_amount, payment_method, payment_status, status, kiosk_access_token, created_at, completed_at)
       VALUES (?, ?, ?, 'motorin', 'amount', 50, ?, ?, 'fleet', 'captured', 'completed', ?, ?, ?)`
    )
    .run(station.id, pumpId, opts.plate, opts.liters, opts.amount, `tok-${Math.random()}`, opts.at, opts.at)
    .lastInsertRowid as number;

  return db
    .prepare(
      `INSERT INTO fleet_movements (fleet_account_id, type, amount, balance_after, transaction_id, created_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
    .run(accountId, opts.type ?? "charge", opts.amount, transactionId, opts.at).lastInsertRowid as number;
}

function addTopup(amount: number, at: string): number {
  return db
    .prepare("INSERT INTO fleet_movements (fleet_account_id, type, amount, balance_after, created_at) VALUES (?, 'topup', ?, 0, ?)")
    .run(accountId, amount, at).lastInsertRowid as number;
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  accountId = createAccount(
    station.id,
    { companyName: "Test Nakliyat A.S.", billingType: "postpaid", vkn: "1234567890" },
    actor
  ).id;
  setInvoiceConfig(
    station.id,
    {
      enabled: true,
      environment: "sandbox",
      username: "u",
      password: "p",
      companyVkn: "9876543210",
      companyTitle: "Test Istasyon A.S.",
    },
    actor
  );
  mockProvider({ Success: true, InvoiceId: "INV-1" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onizleme", () => {
  it("plaka + yakit bazinda toplar, KDV'yi ayristirir", () => {
    // 200 dolumlu bir ayda 200 satirlik fatura ise yaramaz; musterinin istedigi
    // kirilim "hangi arac, hangi yakittan ne kadar".
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    addFill({ plate: "34ABC01", liters: 10, amount: 500, at: "2026-08-11T09:00:00.000Z" });
    addFill({ plate: "06XYZ22", liters: 30, amount: 1500, at: "2026-08-12T09:00:00.000Z" });

    const draft = getInvoiceDraft(station.id, accountId);

    expect(draft.lines).toHaveLength(2);
    expect(draft.lines.find((l) => l.plate === "34ABC01")!.amount).toBe(1500);
    expect(draft.lines.find((l) => l.plate === "34ABC01")!.liters).toBe(30);
    expect(draft.payableAmount).toBe(3000);
    expect(draft.taxExclusiveAmount).toBe(2500);
    expect(draft.taxAmount).toBe(500);
  });

  it("bakiye yuklemesini faturaya KATMAZ", () => {
    // Topup bir satis degil odemedir; faturalanirsa musteri odedigi para icin ikinci
    // kez borclandirilmis olur.
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    addTopup(5000, "2026-08-09T09:00:00.000Z");

    expect(getInvoiceDraft(station.id, accountId).payableAmount).toBe(1000);
  });

  it("iadeyi ait oldugu plakanin satirindan duser", () => {
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    addFill({ plate: "34ABC01", liters: 4, amount: 200, at: "2026-08-11T09:00:00.000Z", type: "refund" });

    const line = getInvoiceDraft(station.id, accountId).lines.find((l) => l.plate === "34ABC01")!;

    expect(line.amount).toBe(800);
    expect(line.liters).toBe(16);
  });

  it("tamami iade edilmis plakayi satir olarak birakmaz", () => {
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-11T09:00:00.000Z", type: "refund" });
    addFill({ plate: "06XYZ22", liters: 10, amount: 500, at: "2026-08-12T09:00:00.000Z" });

    const draft = getInvoiceDraft(station.id, accountId);

    expect(draft.lines.map((l) => l.plate)).toEqual(["06XYZ22"]);
  });

  it("satir toplamlari faturanin genel toplamiyla KURUSU KURUSUNA tutar", () => {
    // GIB, kalemleri genel toplamiyla tutmayan bir belgeyi reddeder. Baslik satirlardan
    // bagimsiz hesaplansaydi bu ornekte 1 kurusluk fark olusurdu:
    // round2(0.01/1.2) + round2(0.03/1.2) = 0.01 + 0.03 = 0.04, ama round2(0.04/1.2) = 0.03.
    addFill({ plate: "34ABC01", liters: 1, amount: 0.01, at: "2026-08-10T09:00:00.000Z" });
    addFill({ plate: "06XYZ22", liters: 1, amount: 0.03, at: "2026-08-10T10:00:00.000Z" });

    const draft = getInvoiceDraft(station.id, accountId);
    const lineTaxExclusive = draft.lines.reduce((n, l) => n + l.taxExclusiveAmount, 0);
    const lineTax = draft.lines.reduce((n, l) => n + l.taxAmount, 0);
    const lineTotal = draft.lines.reduce((n, l) => n + l.amount, 0);

    expect(Math.round(lineTaxExclusive * 100) / 100).toBe(draft.taxExclusiveAmount);
    expect(Math.round(lineTax * 100) / 100).toBe(draft.taxAmount);
    expect(Math.round(lineTotal * 100) / 100).toBe(draft.payableAmount);
    expect(draft.taxExclusiveAmount + draft.taxAmount).toBeCloseTo(draft.payableAmount, 10);
  });

  it("faturalanacak hareket yoksa bos onizleme dondurur", () => {
    const draft = getInvoiceDraft(station.id, accountId);
    expect(draft.movementCount).toBe(0);
    expect(draft.periodStart).toBeNull();
  });
});

describe("fatura kesme", () => {
  it("hareketleri faturaya baglar ve saglayiciya gonderir", async () => {
    const m1 = addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });

    const invoice = await createPeriodInvoice(station.id, accountId, actor);

    expect(invoice.status).toBe("sent");
    expect(invoice.provider_invoice_id).toBe("INV-1");
    expect(invoice.payable_amount).toBe(1000);
    expect(db.prepare<[number], { fleet_invoice_id: number }>("SELECT fleet_invoice_id FROM fleet_movements WHERE id = ?").get(m1)!.fleet_invoice_id).toBe(invoice.id);
  });

  it("ayni hareketi IKINCI kez faturalamaz", async () => {
    // Kurumsal musteriyi cift borclandirmak bu ozellikteki en agir hatadir.
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    await createPeriodInvoice(station.id, accountId, actor);

    await expect(createPeriodInvoice(station.id, accountId, actor)).rejects.toThrow(FleetInvoiceError);
    expect(listFleetInvoices(station.id, accountId)).toHaveLength(1);
  });

  it("faturadan SONRA gelen hareket siradaki faturaya duser", async () => {
    // Kapsam tarihle secilseydi, gec fark edilen bir hareket ya kaybolur ya iki kez
    // faturalanirdi.
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    const first = await createPeriodInvoice(station.id, accountId, actor);

    const late = addFill({ plate: "34ABC01", liters: 10, amount: 500, at: "2026-08-09T09:00:00.000Z" });
    const second = await createPeriodInvoice(station.id, accountId, actor);

    expect(second.id).not.toBe(first.id);
    expect(second.payable_amount).toBe(500);
    expect(db.prepare<[number], { fleet_invoice_id: number }>("SELECT fleet_invoice_id FROM fleet_movements WHERE id = ?").get(late)!.fleet_invoice_id).toBe(second.id);
  });

  it("VKN'siz hesapta kurumsal fatura kesmez", async () => {
    db.prepare("UPDATE fleet_accounts SET vkn = NULL WHERE id = ?").run(accountId);
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });

    await expect(createPeriodInvoice(station.id, accountId, actor)).rejects.toThrow(/VKN/);
  });

  it("e-fatura yapilandirilmamissa reddeder", async () => {
    setInvoiceConfig(station.id, { enabled: false, environment: "sandbox" }, actor);
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });

    await expect(createPeriodInvoice(station.id, accountId, actor)).rejects.toThrow(FleetInvoiceError);
  });

  it("faturalanacak hareket yoksa fatura kaydi olusturmaz", async () => {
    await expect(createPeriodInvoice(station.id, accountId, actor)).rejects.toThrow(FleetInvoiceError);
    expect(listFleetInvoices(station.id, accountId)).toHaveLength(0);
  });

  it("net tutar sifir/negatifse fatura kesmez", async () => {
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-11T09:00:00.000Z", type: "refund" });

    await expect(createPeriodInvoice(station.id, accountId, actor)).rejects.toThrow(FleetInvoiceError);
  });

  it("baska istasyonun hesabina fatura kesemez", async () => {
    const other = createTestStation();
    await expect(createPeriodInvoice(other.id, accountId, actor)).rejects.toThrow();
  });
});

describe("gonderim basarisiz oldugunda", () => {
  it("kayit 'failed' kalir ve hareketler faturaya bagli kalir", async () => {
    // Baglanti geri alinsaydi, saglayiciya gercekte ulasmis bir belge ikinci kez
    // kesilebilirdi.
    const m1 = addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    failingProvider();

    const invoice = await createPeriodInvoice(station.id, accountId, actor);

    expect(invoice.status).toBe("failed");
    expect(invoice.error_message).toContain("baglanilamadi");
    expect(db.prepare<[number], { fleet_invoice_id: number }>("SELECT fleet_invoice_id FROM fleet_movements WHERE id = ?").get(m1)!.fleet_invoice_id).toBe(invoice.id);
  });

  it("basarisiz fatura YENIDEN GONDERILIR, yenisi kesilmez", async () => {
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    failingProvider();
    const failed = await createPeriodInvoice(station.id, accountId, actor);

    mockProvider({ Success: true, InvoiceId: "INV-RETRY" });
    const retried = await retryFleetInvoice(station.id, accountId, failed.id);

    expect(retried.id).toBe(failed.id);
    expect(retried.status).toBe("sent");
    expect(retried.provider_invoice_id).toBe("INV-RETRY");
    expect(listFleetInvoices(station.id, accountId)).toHaveLength(1);
  });

  it("gonderilmis faturayi yeniden gondermez", async () => {
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    const sent = await createPeriodInvoice(station.id, accountId, actor);

    await expect(retryFleetInvoice(station.id, accountId, sent.id)).rejects.toThrow(FleetInvoiceError);
  });

  it("saglayici Success:false donerse basarisiz sayar", async () => {
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    mockProvider({ Success: false, ErrorMessage: "VKN gecersiz" });

    const invoice = await createPeriodInvoice(station.id, accountId, actor);

    expect(invoice.status).toBe("failed");
    expect(invoice.error_message).toBe("VKN gecersiz");
  });

  it("baska hesabin faturasini yeniden gonderemez", async () => {
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    const invoice = await createPeriodInvoice(station.id, accountId, actor);
    const otherAccount = createAccount(station.id, { companyName: "Baska", billingType: "postpaid", vkn: "1" }, actor).id;

    await expect(retryFleetInvoice(station.id, otherAccount, invoice.id)).rejects.toThrow(/bulunamadi/);
  });
});

describe("fatura anlik goruntusu", () => {
  it("sonradan gelen iade, kesilmis faturanin rakamini degistirmez", async () => {
    // Ayni gerekce: fuel_tank_readings.book_liters ve mutabakat gun kapanisi.
    addFill({ plate: "34ABC01", liters: 20, amount: 1000, at: "2026-08-10T09:00:00.000Z" });
    const invoice = await createPeriodInvoice(station.id, accountId, actor);

    addFill({ plate: "34ABC01", liters: 4, amount: 200, at: "2026-08-15T09:00:00.000Z", type: "refund" });

    expect(listFleetInvoices(station.id, accountId).find((i) => i.id === invoice.id)!.payable_amount).toBe(1000);
    // Iade siradaki faturaya (eksi bakiyeli) hareket olarak kalir.
    expect(getInvoiceDraft(station.id, accountId).movementCount).toBe(1);
  });
});
