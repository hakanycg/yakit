import { beforeEach, describe, expect, it } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";
import { db } from "../db/index.js";
import { getInvoiceForTransaction, recordInvoiceFailure, recordInvoiceSuccess, serializeInvoice } from "./invoiceRecordService.js";

let station: StationRow;
let actor: UserRow;

function createTestTransactionId(): number {
  const pumpId = createTestPump(station.id);
  return db
    .prepare(`INSERT INTO transactions (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, kiosk_access_token) VALUES (?, ?, '34ABC123', 'motorin', 'amount', 50, ?)`)
    .run(station.id, pumpId, `tok-${Math.random()}`).lastInsertRowid as number;
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
});

describe("getInvoiceForTransaction", () => {
  it("hic fatura kesilmemis bir islem icin undefined doner", () => {
    const transactionId = createTestTransactionId();
    expect(getInvoiceForTransaction(transactionId)).toBeUndefined();
  });
});

describe("recordInvoiceSuccess", () => {
  it("basarili faturayi 'sent' statusuyle kaydeder", () => {
    const transactionId = createTestTransactionId();
    const invoice = recordInvoiceSuccess(station.id, transactionId, "UYM-1", actor);
    expect(invoice.status).toBe("sent");
    expect(invoice.provider_invoice_id).toBe("UYM-1");
    expect(invoice.created_by).toBe(actor.id);
  });

  it("actor null olabilir - otomatik kesimde kimse ekranin basinda degildir", () => {
    const transactionId = createTestTransactionId();
    const invoice = recordInvoiceSuccess(station.id, transactionId, "UYM-2", null);
    expect(invoice.created_by).toBeNull();
  });

  it("ayni islem icin ikinci kez cagrilirsa (upsert) eski kaydin uzerine yazar, ikinci satir olusturmaz", () => {
    const transactionId = createTestTransactionId();
    recordInvoiceSuccess(station.id, transactionId, "UYM-OLD", actor);
    recordInvoiceSuccess(station.id, transactionId, "UYM-NEW", actor);
    const count = db.prepare<[number], { c: number }>("SELECT COUNT(*) as c FROM invoices WHERE transaction_id = ?").get(transactionId)!.c;
    expect(count).toBe(1);
    expect(getInvoiceForTransaction(transactionId)?.provider_invoice_id).toBe("UYM-NEW");
  });

  it("onceki bir basarisizligin hata mesajini temizler", () => {
    const transactionId = createTestTransactionId();
    recordInvoiceFailure(station.id, transactionId, "baglanti hatasi", actor);
    const invoice = recordInvoiceSuccess(station.id, transactionId, "UYM-3", actor);
    expect(invoice.status).toBe("sent");
    expect(invoice.error_message).toBeNull();
  });
});

describe("recordInvoiceFailure", () => {
  it("basarisiz faturayi 'failed' statusu ve hata mesajiyla kaydeder", () => {
    const transactionId = createTestTransactionId();
    const invoice = recordInvoiceFailure(station.id, transactionId, "saglayiciya baglanilamadi", actor);
    expect(invoice.status).toBe("failed");
    expect(invoice.error_message).toBe("saglayiciya baglanilamadi");
    expect(invoice.provider_invoice_id).toBeNull();
  });

  it("onceki basarili bir faturanin uzerine 'failed' olarak yazar (yeniden deneme basarisiz olursa)", () => {
    const transactionId = createTestTransactionId();
    recordInvoiceSuccess(station.id, transactionId, "UYM-4", actor);
    const invoice = recordInvoiceFailure(station.id, transactionId, "tekrar hata", actor);
    expect(invoice.status).toBe("failed");
    expect(invoice.error_message).toBe("tekrar hata");
  });
});

describe("serializeInvoice", () => {
  it("istemciye donecek alanlari dogru esler", () => {
    const transactionId = createTestTransactionId();
    const invoice = recordInvoiceSuccess(station.id, transactionId, "UYM-5", actor);
    expect(serializeInvoice(invoice)).toEqual({
      status: "sent",
      providerInvoiceId: "UYM-5",
      errorMessage: null,
      createdAt: invoice.created_at,
    });
  });
});
