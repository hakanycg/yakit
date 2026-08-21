import { describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import type { TransactionRow } from "../db/types.js";
import { createTestFuelPrice, createTestPump, createTestStation, createTestUser, setTankStock } from "../test/dbFixture.js";
import {
  cancelPendingTransaction,
  chargeAmount,
  createTransaction,
  emergencyStopTransaction,
  finalizeTransactionPayment,
  markIyzicoPending,
  payTransaction,
  reconcileStaleCreatedTransactions,
  reconcileStuckTransactions,
} from "./transactionService.js";

const VALID_CARD = { cardNumber: "4242 4242 4242 4242", expiryMonth: 12, expiryYear: 2030, cvv: "123", holderName: "Test User" };

function fakeTransaction(overrides: Partial<TransactionRow>): TransactionRow {
  return {
    id: 1,
    station_id: 1,
    pump_id: 1,
    plate: "34TEST01",
    plate_source: "manual",
    fuel_type: "benzin",
    amount_mode: "amount",
    requested_amount: 500,
    requested_liters: null,
    price_per_liter: 44.5,
    dispensed_liters: 11.24,
    total_amount: 500,
    payment_method: "virtual_card",
    payment_status: "captured",
    payment_reference: null,
    status: "completed",
    kiosk_access_token: "tok",
    operator_user_id: null,
    started_at: null,
    completed_at: new Date().toISOString(),
    cancelled_reason: null,
    receipt_email: null,
    receipt_phone: null,
    receipt_sent_at: null,
    discount_code: null,
    discount_amount: 0,
    loyalty_points_redeemed: 0,
    loyalty_points_earned: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("chargeAmount", () => {
  it("equals total_amount when there is no discount", () => {
    const t = fakeTransaction({ total_amount: 500, discount_amount: 0 });
    expect(chargeAmount(t)).toBe(500);
  });

  it("subtracts the discount from total_amount", () => {
    const t = fakeTransaction({ total_amount: 500, discount_amount: 50 });
    expect(chargeAmount(t)).toBe(450);
  });

  it("never goes negative even if discount_amount somehow exceeds total_amount", () => {
    const t = fakeTransaction({ total_amount: 100, discount_amount: 150 });
    expect(chargeAmount(t)).toBe(0);
  });

  it("leaves total_amount itself untouched (fuel value stays the gross figure)", () => {
    const t = fakeTransaction({ total_amount: 500, discount_amount: 50 });
    chargeAmount(t);
    expect(t.total_amount).toBe(500);
  });
});

function setUpStationForTransactions() {
  const station = createTestStation();
  const pumpId = createTestPump(station.id, ["benzin"]);
  createTestFuelPrice(station.id, "benzin", 44.5);
  setTankStock(station.id, "benzin", 500);
  return { station, pumpId };
}

describe("finalizeTransactionPayment payment_status", () => {
  // finalizeTransactionPayment/payTransaction basariyla biterse startDispensing() gercek bir
  // setInterval zamanlayicisi kurar; test bitince bunu (henuz 0 litre dagitilmisken)
  // emergencyStopTransaction ile hemen temizliyoruz - aksi halde arka planda calismaya
  // devam edip test surecinin sonlanmasini geciktirir/gereksiz iyzico cagrilari dener.
  const staff = createTestUser(null, "admin");

  it("holds (does not capture) a full_tank + iyzico payment - the real amount is unknown until dispensing finishes", () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction, accessToken } = createTransaction({ pumpId, plate: "34FUL001", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    markIyzicoPending(transaction.id, accessToken, "iyzico-token-1");
    const updated = finalizeTransactionPayment(transaction.id, { success: true, reference: "iyzico-payment-1", message: "ok" });
    expect(updated.payment_status).toBe("authorized");
    emergencyStopTransaction(transaction.id, staff, "test cleanup");
  });

  it("captures immediately for a liters-mode iyzico payment - the amount is already exact", () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction, accessToken } = createTransaction({
      pumpId,
      plate: "34FUL002",
      plateSource: "manual",
      fuelType: "benzin",
      amountMode: "liters",
      requestedLiters: 10,
    });
    markIyzicoPending(transaction.id, accessToken, "iyzico-token-2");
    const updated = finalizeTransactionPayment(transaction.id, { success: true, reference: "iyzico-payment-2", message: "ok" });
    expect(updated.payment_status).toBe("captured");
    emergencyStopTransaction(transaction.id, staff, "test cleanup");
  });

  it("captures immediately for a full_tank payment via the virtual (simulated) card - no real hold/capture concept applies there", () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction, accessToken } = createTransaction({ pumpId, plate: "34FUL003", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    const updated = payTransaction(transaction.id, accessToken, VALID_CARD);
    expect(updated.payment_status).toBe("captured");
    emergencyStopTransaction(transaction.id, staff, "test cleanup");
  });
});

describe("cancelling a transaction with zero dispensed liters resets total_amount to 0", () => {
  it("cancelPendingTransaction (customer backs out before paying)", () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction, accessToken } = createTransaction({ pumpId, plate: "34CAN001", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    // full_tank tahmini tutar, henuz odeme/dolum olmadan zaten sifirdan buyuk olmali (yoksa test anlamsiz).
    expect(transaction.total_amount).toBeGreaterThan(0);

    const cancelled = cancelPendingTransaction(transaction.id, accessToken, "Musteri vazgecti.");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.dispensed_liters).toBe(0);
    expect(cancelled.total_amount).toBe(0);
  });

  it("emergencyStopTransaction on an authorized-but-not-yet-dispensing transaction", () => {
    const { pumpId } = setUpStationForTransactions();
    const staff = createTestUser(null, "admin");
    const { transaction, accessToken } = createTransaction({ pumpId, plate: "34CAN002", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    payTransaction(transaction.id, accessToken, VALID_CARD);
    // payTransaction -> startDispensing hemen (senkron) dispensed_liters=0 ile "dispensing"
    // durumuna gecirir; ilk tick henuz (500ms sonra) calismadigi icin burada hala 0'dir.
    const stopped = emergencyStopTransaction(transaction.id, staff, "Operator tarafindan durduruldu.");
    expect(stopped.status).toBe("cancelled");
    expect(stopped.dispensed_liters).toBe(0);
    expect(stopped.total_amount).toBe(0);
  });
});

describe("reconcileStuckTransactions", () => {
  // Sunucu (ornegin Railway redeploy'u) dolum devam ederken yeniden baslarsa, dolumu
  // yuruten setInterval yok olur ve islem 'authorized'/'dispensing' durumunda asili kalir.
  // reconcileStuckTransactions() sunucu ac1lisinda bunlari temizler; testte de ayni
  // senaryoyu simule etmek icin gercek zamanlayiciyi emergencyStopTransaction ile hemen
  // durdurup, sonra durumu elle asili duruma geri donduruyoruz.
  it("marks a stuck transaction with dispensed fuel as completed (not cancelled) and keeps the real amount", () => {
    const { pumpId } = setUpStationForTransactions();
    const staff = createTestUser(null, "admin");
    const { transaction, accessToken } = createTransaction({ pumpId, plate: "34REC001", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    payTransaction(transaction.id, accessToken, VALID_CARD);
    emergencyStopTransaction(transaction.id, staff, "test setup - stop the real timer");
    db.prepare("UPDATE transactions SET status = 'dispensing', dispensed_liters = 12.5, total_amount = 556.25 WHERE id = ?").run(transaction.id);

    reconcileStuckTransactions();

    const after = db.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id) as TransactionRow;
    expect(after.status).toBe("completed");
    expect(after.dispensed_liters).toBe(12.5);
    expect(after.total_amount).toBe(556.25);
    expect(after.cancelled_reason).toBe("Sunucu yeniden baslatildi.");
  });

  it("marks a stuck transaction with zero dispensed fuel as cancelled with total_amount reset to 0", () => {
    const { pumpId } = setUpStationForTransactions();
    const staff = createTestUser(null, "admin");
    const { transaction, accessToken } = createTransaction({ pumpId, plate: "34REC002", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    payTransaction(transaction.id, accessToken, VALID_CARD);
    emergencyStopTransaction(transaction.id, staff, "test setup - stop the real timer");
    db.prepare("UPDATE transactions SET status = 'authorized', dispensed_liters = 0 WHERE id = ?").run(transaction.id);

    reconcileStuckTransactions();

    const after = db.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id) as TransactionRow;
    expect(after.status).toBe("cancelled");
    expect(after.total_amount).toBe(0);
  });
});

describe("reconcileStaleCreatedTransactions", () => {
  // Musteri odemeyi hic baslatmadan (status "created") kiosk'tan ayrilirsa, pompa
  // sonsuza dek "reserved" kalirdi - bunu simule etmek icin created_at'i elle
  // gecmise cekiyoruz (gercek zamanlayici beklemeden ayni etkiyi elde etmek icin).
  it("cancels a 'created' transaction older than the cutoff and frees the pump", () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction } = createTransaction({ pumpId, plate: "34STA001", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    expect(transaction.total_amount).toBeGreaterThan(0);
    db.prepare("UPDATE transactions SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 minutes') WHERE id = ?").run(
      transaction.id
    );

    reconcileStaleCreatedTransactions(10 * 60 * 1000);

    const after = db.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id) as TransactionRow;
    expect(after.status).toBe("cancelled");
    expect(after.total_amount).toBe(0);
    const pump = db.prepare("SELECT status, current_transaction_id FROM pumps WHERE id = ?").get(pumpId) as {
      status: string;
      current_transaction_id: number | null;
    };
    expect(pump.status).toBe("idle");
    expect(pump.current_transaction_id).toBeNull();
  });

  it("leaves a recently-created transaction untouched", () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction } = createTransaction({ pumpId, plate: "34STA002", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });

    reconcileStaleCreatedTransactions(10 * 60 * 1000);

    const after = db.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id) as TransactionRow;
    expect(after.status).toBe("created");
    const pump = db.prepare("SELECT status FROM pumps WHERE id = ?").get(pumpId) as { status: string };
    expect(pump.status).toBe("reserved");
  });
});
