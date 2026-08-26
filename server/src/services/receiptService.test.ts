import { describe, expect, it } from "vitest";
import type { StationRow, TransactionRow } from "../db/types.js";
import { buildReceiptRows, buildReceiptText } from "./receiptService.js";

const station = {
  name: "Merkez Yakit",
  address: "Ataturk Bulvari No:1",
  contact_phone: "0312 555 00 00",
} as StationRow;

function sale(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: 42,
    plate: "34ABC123",
    fuel_type: "motorin",
    dispensed_liters: 20,
    price_per_liter: 50,
    total_amount: 1000,
    discount_amount: 0,
    payment_method: "iyzico",
    completed_at: "2026-08-26T10:00:00.000Z",
    ...overrides,
  } as TransactionRow;
}

/** Satirlari "etiket -> deger" haritasina cevirir; sira degisse de test kirilmasin. */
function asMap(t: TransactionRow): Record<string, string> {
  return Object.fromEntries(buildReceiptRows(t));
}

describe("makbuz tutarlari", () => {
  it("indirim yokken tek bir 'Odenen Tutar' satiri yazar - ayni rakami iki kez yazmaz", () => {
    const rows = asMap(sale());
    expect(rows["Odenen Tutar"]).toContain("1.000,00");
    expect(rows["Ara Toplam"]).toBeUndefined();
    expect(rows["Indirim / Puan"]).toBeUndefined();
  });

  it("indirim varsa musteriden GERCEKTEN tahsil edileni yazar, yakit degerini degil", () => {
    const rows = asMap(sale({ total_amount: 1000, discount_amount: 150 }));
    expect(rows["Ara Toplam"]).toContain("1.000,00");
    expect(rows["Indirim / Puan"]).toContain("150,00");
    // Kritik olan bu: makbuz 1000 degil 850 demeli.
    expect(rows["Odenen Tutar"]).toContain("850,00");
  });

  it("indirim yakit degerini asarsa tutar eksiye dusmez", () => {
    const rows = asMap(sale({ total_amount: 100, discount_amount: 250 }));
    expect(rows["Odenen Tutar"]).toContain("0,00");
    expect(rows["Odenen Tutar"]).not.toContain("-");
  });

  it("odeme yontemini okunur yazar", () => {
    expect(asMap(sale({ payment_method: "fleet" }))["Odeme Yontemi"]).toBe("Filo Hesabi");
    expect(asMap(sale())["Odeme Yontemi"]).toBe("Kredi/Banka Karti");
  });

  it("makbuz artik kendini 'sanal' diye tanitmaz", () => {
    const text = buildReceiptText(sale(), station);
    expect(text.toLowerCase()).not.toContain("sanal");
    expect(text).toContain("mali belge yerine gecmez");
  });

  it("istasyon telefonu varsa basliga eklenir, yoksa bos satir birakilmaz", () => {
    expect(buildReceiptText(sale(), station)).toContain("Tel: 0312 555 00 00");
    const noPhone = { ...station, contact_phone: null } as StationRow;
    expect(buildReceiptText(sale(), noPhone)).not.toContain("Tel:");
  });
});
