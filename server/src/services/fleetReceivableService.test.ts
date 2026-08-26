import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { FleetAccountRow, StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestTransaction, createTestUser } from "../test/dbFixture.js";
import { FleetError, chargeAccount, createAccount, topUp, updateContact } from "./fleetService.js";
import { accountReceivable, blockingOverdue, stationAging, sweepOverdueReceivables } from "./fleetReceivableService.js";

vi.mock("./notificationService.js", () => ({
  sendEmail: vi.fn(async () => {}),
  sendSms: vi.fn(async () => {}),
}));

let station: StationRow;
let actor: UserRow;
let account: FleetAccountRow;

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-15T12:00:00.000Z");

function reload(id = account.id): FleetAccountRow {
  return db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(id)!;
}

/** Kesilmis bir donem faturasi. Tutar ve vade fatura kesildigi anda dondurulur. */
function addInvoice(opts: { amount: number; issuedDaysAgo: number; dueDaysAgo: number | null; status?: "sent" | "failed" | "pending" }): number {
  const issuedAt = new Date(NOW - opts.issuedDaysAgo * DAY).toISOString();
  const dueDate = opts.dueDaysAgo === null ? null : new Date(NOW - opts.dueDaysAgo * DAY).toISOString();
  return db
    .prepare(
      `INSERT INTO fleet_invoices
         (station_id, fleet_account_id, status, period_start, period_end, total_liters,
          tax_exclusive_amount, tax_amount, payable_amount, lines_json, due_date, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, '[]', ?, ?)`
    )
    .run(station.id, account.id, opts.status ?? "sent", issuedAt, issuedAt, opts.amount, dueDate, issuedAt)
    .lastInsertRowid as number;
}

/** Faturalanmamis bir yakit alimi (charge) ya da iade (refund) hareketi. */
function addMovement(type: "charge" | "refund", amount: number, invoiceId: number | null = null): void {
  db.prepare(
    "INSERT INTO fleet_movements (fleet_account_id, type, amount, balance_after, fleet_invoice_id) VALUES (?, ?, ?, 0, ?)"
  ).run(account.id, type, amount, invoiceId);
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  account = createAccount(station.id, { companyName: "Vade Nakliyat", billingType: "postpaid" }, actor);
});

describe("alacak defteri - odeme eslestirmesi", () => {
  it("odeme en ESKI faturayi once kapatir (FIFO)", () => {
    addInvoice({ amount: 1000, issuedDaysAgo: 60, dueDaysAgo: 30 });
    addInvoice({ amount: 1000, issuedDaysAgo: 30, dueDaysAgo: 0 });
    topUp(station.id, account.id, 1000, "kismi odeme", actor);

    const ledger = accountReceivable(reload(), NOW);
    expect(ledger.invoices[0]!.remainingAmount).toBe(0);
    expect(ledger.invoices[1]!.remainingAmount).toBe(1000);
    expect(ledger.openAmount).toBe(1000);
  });

  it("borctan fazla odeme kaybolmaz, alacakli bakiye olarak gorunur", () => {
    addInvoice({ amount: 500, issuedDaysAgo: 10, dueDaysAgo: null });
    topUp(station.id, account.id, 800, undefined, actor);

    const ledger = accountReceivable(reload(), NOW);
    expect(ledger.openAmount).toBe(0);
    expect(ledger.creditAmount).toBe(300);
  });

  it("iade bir odeme DEGILDIR - donem faturasinda zaten netleniyor, iki kez dusulmez", () => {
    addInvoice({ amount: 1000, issuedDaysAgo: 40, dueDaysAgo: 10 });
    addMovement("refund", 400); // henuz faturalanmamis bir iade

    const ledger = accountReceivable(reload(), NOW);
    // Iade acik faturayi kapatmaz; bir sonraki faturada dusulecek bir alacaktir.
    expect(ledger.openAmount).toBe(1000);
    expect(ledger.unbilledAmount).toBe(-400);
  });

  it("faturalanmamis tutar yalnizca faturaya baglanmamis hareketleri sayar", () => {
    const invoiceId = addInvoice({ amount: 1000, issuedDaysAgo: 40, dueDaysAgo: 10 });
    addMovement("charge", 1000, invoiceId); // faturalanmis
    addMovement("charge", 300); // faturalanmamis
    addMovement("refund", 100); // faturalanmamis

    expect(accountReceivable(reload(), NOW).unbilledAmount).toBe(200);
  });
});

describe("alacak defteri - vade", () => {
  it("vadesi gecmis fatura gun sayisiyla birlikte raporlanir", () => {
    addInvoice({ amount: 2500, issuedDaysAgo: 75, dueDaysAgo: 45 });
    const ledger = accountReceivable(reload(), NOW);
    expect(ledger.overdueAmount).toBe(2500);
    expect(ledger.oldestOverdueDays).toBe(45);
    expect(ledger.buckets.d31to60).toBe(2500);
  });

  it("vadesi gelmemis fatura gecikmis sayilmaz", () => {
    addInvoice({ amount: 900, issuedDaysAgo: 5, dueDaysAgo: -25 });
    const ledger = accountReceivable(reload(), NOW);
    expect(ledger.overdueAmount).toBe(0);
    expect(ledger.buckets.current).toBe(900);
  });

  it("MUSTERIYE ILETILEMEMIS fatura hicbir zaman gecikmis sayilmaz", () => {
    // Musteri bu faturayi hic gormedi; pesine dusmek yanlis olurdu.
    addInvoice({ amount: 1500, issuedDaysAgo: 90, dueDaysAgo: 60, status: "failed" });
    const ledger = accountReceivable(reload(), NOW);
    expect(ledger.openAmount).toBe(1500);
    expect(ledger.overdueAmount).toBe(0);
    expect(ledger.invoices[0]!.delivered).toBe(false);
  });

  it("vade tanimsizsa (hesapta vade girilmemis) gecikme islemez", () => {
    addInvoice({ amount: 700, issuedDaysAgo: 120, dueDaysAgo: null });
    const ledger = accountReceivable(reload(), NOW);
    expect(ledger.overdueAmount).toBe(0);
    expect(ledger.buckets.current).toBe(700);
  });

  it("yaslandirma kovalari dogru dagitir", () => {
    addInvoice({ amount: 100, issuedDaysAgo: 200, dueDaysAgo: 120 });
    addInvoice({ amount: 200, issuedDaysAgo: 150, dueDaysAgo: 75 });
    addInvoice({ amount: 400, issuedDaysAgo: 90, dueDaysAgo: 45 });
    addInvoice({ amount: 800, issuedDaysAgo: 40, dueDaysAgo: 15 });

    const b = accountReceivable(reload(), NOW).buckets;
    expect(b.d90plus).toBe(100);
    expect(b.d61to90).toBe(200);
    expect(b.d31to60).toBe(400);
    expect(b.d1to30).toBe(800);
  });

  it("yaslandirma tablosunda en riskli hesap en ustte gelir", () => {
    addInvoice({ amount: 100, issuedDaysAgo: 20, dueDaysAgo: 5 });
    const other = createAccount(station.id, { companyName: "Az Riskli", billingType: "postpaid" }, actor);
    const saved = account;
    account = other;
    addInvoice({ amount: 100, issuedDaysAgo: 200, dueDaysAgo: 150 });
    account = saved;

    const rows = stationAging(station.id, NOW);
    expect(rows[0]!.companyName).toBe("Az Riskli");
    expect(rows[0]!.oldestOverdueDays).toBe(150);
  });
});

describe("gecikmede yakit alimini durdurma", () => {
  it("varsayilan olarak KAPALIDIR - ayar girilmeden hicbir hesap durdurulmaz", () => {
    addInvoice({ amount: 5000, issuedDaysAgo: 300, dueDaysAgo: 250 });
    expect(blockingOverdue(reload(), NOW)).toBeNull();
  });

  it("tolerans suresi dolmadan durdurmaz", () => {
    updateContact(station.id, account.id, { overdueBlockDays: 30 });
    addInvoice({ amount: 5000, issuedDaysAgo: 40, dueDaysAgo: 10 });
    expect(blockingOverdue(reload(), NOW)).toBeNull();
  });

  it("tolerans dolunca yakit alimi reddedilir ve hata tutari/gunu soyler", () => {
    updateContact(station.id, account.id, { overdueBlockDays: 30 });
    addInvoice({ amount: 5000, issuedDaysAgo: 90, dueDaysAgo: 45 });

    const blocking = blockingOverdue(reload(), NOW);
    expect(blocking).not.toBeNull();
    expect(blocking!.days).toBe(45);
    expect(blocking!.amount).toBe(5000);
  });

  it("borc kapaninca durdurma kalkar", () => {
    updateContact(station.id, account.id, { overdueBlockDays: 30 });
    addInvoice({ amount: 5000, issuedDaysAgo: 90, dueDaysAgo: 45 });
    topUp(station.id, account.id, 5000, "tahsilat", actor);
    expect(blockingOverdue(reload(), NOW)).toBeNull();
  });

  it("on odemeli hesapta bu kontrol hic calismaz", () => {
    const prepaid = createAccount(station.id, { companyName: "On Odemeli", billingType: "prepaid" }, actor);
    updateContact(station.id, prepaid.id, { overdueBlockDays: 1 });
    expect(blockingOverdue(reload(prepaid.id), NOW)).toBeNull();
  });
});

describe("gecikme taramasi", () => {
  function openAlarms(): number {
    return db
      .prepare<[number, string], { c: number }>(
        "SELECT COUNT(*) AS c FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved'"
      )
      .get(station.id, `fleet_overdue_${account.id}`)!.c;
  }

  it("gecikmis hesap icin bir kez alarm acar, her taramada tekrarlamaz", () => {
    updateContact(station.id, account.id, { paymentTermDays: 30 });
    addInvoice({ amount: 3000, issuedDaysAgo: 60, dueDaysAgo: 30 });

    sweepOverdueReceivables(NOW);
    sweepOverdueReceivables(NOW);
    expect(openAlarms()).toBe(1);
  });

  it("borc kapaninca alarm cozulur", () => {
    updateContact(station.id, account.id, { paymentTermDays: 30 });
    addInvoice({ amount: 3000, issuedDaysAgo: 60, dueDaysAgo: 30 });
    sweepOverdueReceivables(NOW);

    topUp(station.id, account.id, 3000, "tahsilat", actor);
    sweepOverdueReceivables(NOW);
    expect(openAlarms()).toBe(0);
  });

  it("vade tanimlanmamis hesap taramaya hic girmez", () => {
    addInvoice({ amount: 3000, issuedDaysAgo: 200, dueDaysAgo: 150 });
    sweepOverdueReceivables(NOW);
    expect(openAlarms()).toBe(0);
  });
});

describe("pompa tarafi", () => {
  it("durdurulmus hesapta yakit alimi hata verir", () => {
    updateContact(station.id, account.id, { overdueBlockDays: 15 });
    addInvoice({ amount: 5000, issuedDaysAgo: 90, dueDaysAgo: 45 });

    const pumpId = createTestPump(station.id);
    expect(() => chargeAccount(station.id, account.id, 100, createTestTransaction(station.id, pumpId))).toThrow(FleetError);
  });

  it("gecikmesi olmayan hesapta yakit alimi normal calisir", () => {
    updateContact(station.id, account.id, { overdueBlockDays: 15 });
    const pumpId = createTestPump(station.id);
    const charged = chargeAccount(station.id, account.id, 100, createTestTransaction(station.id, pumpId));
    expect(charged.balance).toBe(100);
  });
});
