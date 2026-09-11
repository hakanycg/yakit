import { describe, expect, it, vi, afterEach } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { db } from "../db/index.js";
import { createAccount } from "./fleetService.js";
import { setInvoiceConfig } from "./invoiceSettingsService.js";
import { createPeriodInvoice } from "./fleetInvoiceService.js";
import { buildFleetInvoicePdf } from "./fleetInvoicePdfService.js";

function mockProvider(response: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => response }) as unknown as Response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildFleetInvoicePdf", () => {
  it("gecerli bir PDF (magic bytes) uretir", async () => {
    const station: StationRow = createTestStation();
    const actor: UserRow = createTestUser(station.id, "admin");
    const accountRow = createAccount(station.id, { companyName: "Test Nakliyat A.S.", billingType: "postpaid", vkn: "1234567890" }, actor);
    setInvoiceConfig(
      station.id,
      { enabled: true, environment: "sandbox", username: "u", password: "p", companyVkn: "9876543210", companyTitle: "Test Istasyon A.S." },
      actor
    );
    mockProvider({ Success: true, InvoiceId: "INV-PDF-1" });

    const pumpId = createTestPump(station.id);
    const transactionId = db
      .prepare(
        `INSERT INTO transactions
           (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
            total_amount, payment_method, payment_status, status, kiosk_access_token, created_at, completed_at)
         VALUES (?, ?, '34PDF01', 'motorin', 'amount', 50, 20, 1000, 'fleet', 'captured', 'completed', ?, ?, ?)`
      )
      .run(station.id, pumpId, `tok-${Math.random()}`, "2026-08-10T09:00:00.000Z", "2026-08-10T09:00:00.000Z").lastInsertRowid as number;
    db.prepare(
      `INSERT INTO fleet_movements (fleet_account_id, type, amount, balance_after, transaction_id, created_at)
       VALUES (?, 'charge', 1000, 0, ?, ?)`
    ).run(accountRow.id, transactionId, "2026-08-10T09:00:00.000Z");

    const invoice = await createPeriodInvoice(station.id, accountRow.id, actor);
    expect(invoice.status).toBe("sent");

    const pdf = await buildFleetInvoicePdf(invoice, accountRow, station);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(100);
  });

  it("VKN'siz bir hesap icin de (VKN satiri atlanarak) PDF uretir", async () => {
    const station: StationRow = createTestStation();
    const invoice = {
      id: 1,
      station_id: station.id,
      fleet_account_id: 1,
      status: "sent" as const,
      provider: "uyumsoft",
      provider_invoice_id: "INV-2",
      error_message: null,
      period_start: "2026-08-01T00:00:00.000Z",
      period_end: "2026-08-31T00:00:00.000Z",
      total_liters: 20,
      tax_exclusive_amount: 833.33,
      tax_amount: 166.67,
      payable_amount: 1000,
      lines_json: JSON.stringify([{ plate: "34PDF02", fuelType: "motorin", liters: 20, amount: 1000, taxExclusiveAmount: 833.33, taxAmount: 166.67 }]),
      due_date: null,
      created_by: null,
      created_at: "2026-09-01T00:00:00.000Z",
    };
    const account = {
      id: 1,
      station_id: station.id,
      company_name: "VKN'siz Musteri",
      vkn: null,
      billing_type: "postpaid" as const,
      balance: 0,
      credit_limit: null,
      active: 1,
      contact_email: null,
      contact_phone: null,
      low_balance_threshold: null,
      payment_term_days: null,
      overdue_block_days: null,
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: null,
      discount_type: null,
      discount_value: null,
    };

    const pdf = await buildFleetInvoicePdf(invoice, account, station);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
