import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createAccount as createFleetAccount } from "./fleetService.js";
import { createAccount as createCashAccount, recordMovement } from "./cashAccountService.js";
import { getCashFlowForecast } from "./cashFlowForecastService.js";

vi.mock("./notificationService.js", () => ({
  sendEmail: vi.fn(async () => {}),
  sendSms: vi.fn(async () => {}),
}));

let station: StationRow;
let actor: UserRow;

const DAY = 86_400_000;

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString();
}

/** getSupplierLedger'in bekledigi minimum satir kumesi: tedarikci + teslim alinmis (received) siparis + maliyetli stok hareketi. */
function addSupplierDebt(amountOwed: number): void {
  const supplierId = db
    .prepare("INSERT INTO fuel_suppliers (station_id, name) VALUES (?, 'Test Tedarikci')")
    .run(station.id).lastInsertRowid as number;
  const movementId = db
    .prepare(
      `INSERT INTO fuel_stock_movements (station_id, fuel_type, type, liters, balance_after, unit_cost)
       VALUES (?, 'motorin', 'delivery', 1000, 1000, ?)`
    )
    .run(station.id, amountOwed / 1000).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO fuel_orders (station_id, fuel_type, supplier_id, supplier_name, ordered_liters, unit_cost, status, delivery_movement_id, received_liters, received_at)
     VALUES (?, 'motorin', ?, 'Test Tedarikci', 1000, ?, 'received', ?, 1000, ?)`
  ).run(station.id, supplierId, amountOwed / 1000, movementId, new Date().toISOString());
}

/** Iletilmis (delivered), vadesi tanimli bir filo faturasi. */
function addFleetInvoice(fleetAccountId: number, amount: number, dueDate: string): void {
  db.prepare(
    `INSERT INTO fleet_invoices
       (station_id, fleet_account_id, status, period_start, period_end, total_liters,
        tax_exclusive_amount, tax_amount, payable_amount, lines_json, due_date, created_at)
     VALUES (?, ?, 'sent', ?, ?, 0, 0, 0, ?, '[]', ?, ?)`
  ).run(station.id, fleetAccountId, dueDate, dueDate, amount, dueDate, dueDate);
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
});

describe("getCashFlowForecast", () => {
  it("baslangic bakiyesi kasa/banka hesaplarinin toplamidir", () => {
    const account = createCashAccount(station.id, { name: "Ana Kasa", kind: "cash" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "in", amount: 5000, movementDate: "2024-01-01" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "out", amount: 1000, movementDate: "2024-01-02" }, actor);

    const forecast = getCashFlowForecast(station.id, 5);
    expect(forecast.startingBalance).toBe(4000);
  });

  it("pasif hesabin bakiyesini baslangica DAHIL ETMEZ", () => {
    const account = createCashAccount(station.id, { name: "Kapatilan Hesap", kind: "bank" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "in", amount: 9999, movementDate: "2024-01-01" }, actor);
    db.prepare("UPDATE cash_accounts SET active = 0 WHERE id = ?").run(account.id);

    const forecast = getCashFlowForecast(station.id, 5);
    expect(forecast.startingBalance).toBe(0);
  });

  it("guncel tedarikci borcunu ILK GUNE (vadesiz oldugu icin) cikis olarak yerlestirir", () => {
    const account = createCashAccount(station.id, { name: "Ana Kasa", kind: "cash" }, actor);
    recordMovement(station.id, { accountId: account.id, direction: "in", amount: 10000, movementDate: "2024-01-01" }, actor);
    addSupplierDebt(3000);

    const forecast = getCashFlowForecast(station.id, 3);
    expect(forecast.immediateSupplierDebt).toBe(3000);
    expect(forecast.days[0]!.expectedOutflow).toBe(3000);
    expect(forecast.days[0]!.projectedBalance).toBe(7000);
    expect(forecast.days[1]!.expectedOutflow).toBe(0);
  });

  it("iletilmis ve vadesi tanimli bir filo faturasini VADE GUNUNE giris olarak yerlestirir", () => {
    const cashAccount = createCashAccount(station.id, { name: "Ana Kasa", kind: "cash" }, actor);
    recordMovement(station.id, { accountId: cashAccount.id, direction: "in", amount: 1000, movementDate: "2024-01-01" }, actor);

    const fleetAccount = createFleetAccount(station.id, { companyName: "Vade Nakliyat", billingType: "postpaid" }, actor);
    const dueInThreeDays = isoDaysFromNow(3);
    addFleetInvoice(fleetAccount.id, 2500, dueInThreeDays);

    const forecast = getCashFlowForecast(station.id, 7);
    const dueDay = dueInThreeDays.slice(0, 10);
    const dayPoint = forecast.days.find((d) => d.date === dueDay)!;
    expect(dayPoint.expectedInflow).toBe(2500);
    // Vade gununden SONRAKI bakiye 1000 + 2500 = 3500 olmali.
    expect(dayPoint.projectedBalance).toBe(3500);
  });

  it("iletilmemis (delivered=false) bir faturayi projeksiyona DAHIL ETMEZ", () => {
    const fleetAccount = createFleetAccount(station.id, { companyName: "Iletilmemis Ltd", billingType: "postpaid" }, actor);
    db.prepare(
      `INSERT INTO fleet_invoices
         (station_id, fleet_account_id, status, period_start, period_end, total_liters,
          tax_exclusive_amount, tax_amount, payable_amount, lines_json, due_date, created_at)
       VALUES (?, ?, 'failed', ?, ?, 0, 0, 0, 5000, '[]', ?, ?)`
    ).run(station.id, fleetAccount.id, isoDaysFromNow(2), isoDaysFromNow(2), isoDaysFromNow(2), isoDaysFromNow(2));

    const forecast = getCashFlowForecast(station.id, 7);
    expect(forecast.days.every((d) => d.expectedInflow === 0)).toBe(true);
  });

  it("vadesiz (due_date=NULL) bir faturayi projeksiyona DAHIL ETMEZ", () => {
    const fleetAccount = createFleetAccount(station.id, { companyName: "Vadesiz Ltd", billingType: "postpaid" }, actor);
    addFleetInvoice(fleetAccount.id, 5000, isoDaysFromNow(2));
    db.prepare("UPDATE fleet_invoices SET due_date = NULL WHERE fleet_account_id = ?").run(fleetAccount.id);

    const forecast = getCashFlowForecast(station.id, 7);
    expect(forecast.days.every((d) => d.expectedInflow === 0)).toBe(true);
  });

  it("gecmis vadeli (zaten vadesi gecmis) bir faturayi ilk gune toplar", () => {
    const cashAccount = createCashAccount(station.id, { name: "Ana Kasa", kind: "cash" }, actor);
    recordMovement(station.id, { accountId: cashAccount.id, direction: "in", amount: 0.01, movementDate: "2024-01-01" }, actor);
    const fleetAccount = createFleetAccount(station.id, { companyName: "Gecikmis Ltd", billingType: "postpaid" }, actor);
    addFleetInvoice(fleetAccount.id, 1500, isoDaysFromNow(-10));

    const forecast = getCashFlowForecast(station.id, 3);
    expect(forecast.days[0]!.expectedInflow).toBe(1500);
  });

  it("gun listesi istenen ufuk (horizonDays) kadar uzunluktadir", () => {
    const forecast = getCashFlowForecast(station.id, 14);
    expect(forecast.days).toHaveLength(14);
  });
});
