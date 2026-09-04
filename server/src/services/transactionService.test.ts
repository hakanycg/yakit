import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { AlarmRow, TransactionRow } from "../db/types.js";
import { createTestFuelPrice, createTestPump, createTestStation, createTestUser, setTankStock } from "../test/dbFixture.js";
import { createAccount as createFleetAccount, addPlate as addFleetPlate, topUp as topUpFleetAccount } from "./fleetService.js";
import { clearDispenserDriverRegistry, setDispenserDriver, setDispenserDriverFor, simulatedDispenserDriver, type DispenserDriver } from "./dispenserDriver.js";
import { setAutomationDriver, noopAutomationDriver, type AutomationDriver, type AutomationSaleReport } from "./automationDriver.js";
import { setWrongFuelMode } from "./wrongFuelSettingsService.js";
import {
  cancelPendingTransaction,
  chargeAmount,
  createTransaction,
  emergencyStopStation,
  emergencyStopTransaction,
  handleLatePaymentAfterCancellation,
  markIyzicoPending,
  finalizeTransactionPayment,
  listTransactionsPaged,
  payWithFleetAccount,
  reconcileStaleCreatedTransactions,
  reconcileStuckTransactions,
} from "./transactionService.js";

/** Testlerde "odeme onaylandi" noktasina gecmek icin: gercek saglayici cagrisi yapilmaz. */
function payOk(id: number) {
  return finalizeTransactionPayment(id, { success: true, reference: "TEST-OK", message: "Odeme onaylandi." });
}

function fakeTransaction(overrides: Partial<TransactionRow>): TransactionRow {
  return {
    id: 1,
    station_id: 1,
    pump_id: 1,
    plate: "34TEST01",
    plate_source: "manual",
    odometer_km: null,
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
    const { transaction } = createTransaction({ pumpId, plate: "34FUL003", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    const updated = payOk(transaction.id);
    expect(updated.payment_status).toBe("captured");
    emergencyStopTransaction(transaction.id, staff, "test cleanup");
  });
});

const staffForMultiPumpTest = createTestUser(null, "admin");

describe("coklu pompa cihazi mimarisi (per-pump dispenser driver)", () => {
  afterEach(() => {
    setDispenserDriver(simulatedDispenserDriver);
    clearDispenserDriverRegistry();
  });

  it("her pompa KENDI atanmis surucusunu kullanir - biri digerini etkilemez", async () => {
    const station = createTestStation();
    const pumpA = createTestPump(station.id, ["benzin"]);
    const pumpB = createTestPump(station.id, ["benzin"]);
    createTestFuelPrice(station.id, "benzin", 44.5);
    setTankStock(station.id, "benzin", 5000);

    const driverA: DispenserDriver = {
      pickFullTankTargetLiters: () => null,
      tick: () => ({ liters: 3, nozzleStopped: true }),
      estimateMaxFullTankLiters: () => 30,
    };
    const driverB: DispenserDriver = {
      pickFullTankTargetLiters: () => null,
      tick: () => ({ liters: 7, nozzleStopped: true }),
      estimateMaxFullTankLiters: () => 70,
    };
    setDispenserDriverFor(pumpA, driverA);
    setDispenserDriverFor(pumpB, driverB);

    // full_tank tahmini fiyati: pompaya ozel estimateMaxFullTankLiters() * birim fiyat kullanilmali.
    const { transaction: tA } = createTransaction({ pumpId: pumpA, plate: "34MPD001", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    const { transaction: tB } = createTransaction({ pumpId: pumpB, plate: "34MPD002", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    expect(tA.total_amount).toBeCloseTo(30 * 44.5);
    expect(tB.total_amount).toBeCloseTo(70 * 44.5);

    // Dolum baslarken de ayni pompaya ozel surucunun tick()'i kullanilmali (7L/A tick'i
    // degil, kendi 3L'lik driverA'si).
    vi.useFakeTimers();
    try {
      payOk(tA.id);
      await vi.advanceTimersByTimeAsync(600);
      const finalA = db.prepare<[number], TransactionRow>("SELECT * FROM transactions WHERE id = ?").get(tA.id)!;
      expect(finalA.dispensed_liters).toBeCloseTo(3);
    } finally {
      vi.useRealTimers();
      emergencyStopTransaction(tB.id, staffForMultiPumpTest, "test cleanup");
    }
  });
});

describe("AutomationDriver entegrasyonu (IOS - gercek donanim/vendor karari beklenen hazir altyapi)", () => {
  afterEach(() => {
    setAutomationDriver(noopAutomationDriver);
    setDispenserDriver(simulatedDispenserDriver);
    vi.useRealTimers();
  });

  it("dolum baslarken reportDispenseStart'i, tamamlaninca reportSaleCompleted'i cagirir", async () => {
    const { pumpId } = setUpStationForTransactions();
    const dispenseStarts: number[] = [];
    const completedReports: AutomationSaleReport[] = [];
    const fakeAutomation: AutomationDriver = {
      reportDispenseStart: (_stationId, _pumpId, transactionId) => dispenseStarts.push(transactionId),
      reportSaleCompleted: (report) => completedReports.push(report),
      sendAliveSignal: () => {},
    };
    setAutomationDriver(fakeAutomation);
    // Gercek simulasyon suruculu bir dolumun tamamlanmasini beklemek (28-55L, ~0.5L/s)
    // testi gereksiz yavaslatir - burada sadece AutomationDriver kancalarinin dogru
    // anlarda cagrildigini kontrol ediyoruz, dolum hizini degil.
    const instantDriver: DispenserDriver = {
      pickFullTankTargetLiters: () => null,
      tick: () => ({ liters: 5, nozzleStopped: true }),
      estimateMaxFullTankLiters: () => 60,
    };
    setDispenserDriver(instantDriver);

    vi.useFakeTimers();
    const { transaction } = createTransaction({
      pumpId,
      plate: "34AUT001",
      plateSource: "manual",
      fuelType: "benzin",
      amountMode: "liters",
      requestedLiters: 5,
    });
    payOk(transaction.id);

    expect(dispenseStarts).toEqual([transaction.id]);
    expect(completedReports).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(600);

    expect(completedReports).toHaveLength(1);
    expect(completedReports[0]!.transactionId).toBe(transaction.id);
    expect(completedReports[0]!.liters).toBeCloseTo(5);
  });
});

describe("handleLatePaymentAfterCancellation (iyzico basarili sonucu, biz zaman asimiyla iptal ettikten SONRA gelirse)", () => {
  it("full_tank (on-provizyon) icin otomatik iptali dener ve KRITIK bir alarm birakir", () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction, accessToken } = createTransaction({ pumpId, plate: "34LATE01", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    cancelPendingTransaction(transaction.id, accessToken, "test - zaman asimi simulasyonu");
    const cancelled = db.prepare<[number], TransactionRow>("SELECT * FROM transactions WHERE id = ?").get(transaction.id)!;
    expect(cancelled.status).toBe("cancelled");

    // Test ortaminda iyzico anahtarlari tanimli degil, bu yuzden cancelPreAuthHold gercekten
    // basarisiz olacak - onemli olan bunun sessizce yutulmayip KRITIK bir alarma donusmesi.
    return handleLatePaymentAfterCancellation(cancelled, "fake-payment-id").then(() => {
      const alarms = db
        .prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?")
        .all(cancelled.station_id, "late_payment_after_cancel");
      expect(alarms.length).toBe(1);
      expect(alarms[0]!.severity).toBe("critical");
      expect(alarms[0]!.message).toContain("OTOMATIK IPTAL EDILEMEDI");
    });
  });

  it("dogrudan tahsilat modunda (full_tank disi) iyzico'ya hic istek atmadan dogrudan KRITIK alarm birakir", async () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction, accessToken } = createTransaction({
      pumpId,
      plate: "34LATE02",
      plateSource: "manual",
      fuelType: "benzin",
      amountMode: "liters",
      requestedLiters: 10,
    });
    cancelPendingTransaction(transaction.id, accessToken, "test - zaman asimi simulasyonu");
    const cancelled = db.prepare<[number], TransactionRow>("SELECT * FROM transactions WHERE id = ?").get(transaction.id)!;

    await handleLatePaymentAfterCancellation(cancelled, "fake-payment-id");

    const alarms = db
      .prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?")
      .all(cancelled.station_id, "late_payment_after_cancel");
    expect(alarms.length).toBe(1);
    expect(alarms[0]!.severity).toBe("critical");
    expect(alarms[0]!.message).toContain("DOGRUDAN BIR TAHSILAT");
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
    const { transaction } = createTransaction({ pumpId, plate: "34CAN002", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    payOk(transaction.id);
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
    const { transaction } = createTransaction({ pumpId, plate: "34REC001", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    payOk(transaction.id);
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
    const { transaction } = createTransaction({ pumpId, plate: "34REC002", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    payOk(transaction.id);
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

describe("payWithFleetAccount", () => {
  it("charges the fleet account and finalizes the payment as 'captured'", () => {
    const { pumpId } = setUpStationForTransactions();
    const station = db.prepare("SELECT station_id FROM pumps WHERE id = ?").get(pumpId) as { station_id: number };
    const staff = createTestUser(null, "admin");
    const fleet = createFleetAccount(station.station_id, { companyName: "Test Filo", billingType: "prepaid" }, staff);
    addFleetPlate(station.station_id, fleet.id, "34FLT001");
    topUpFleetAccount(station.station_id, fleet.id, 1000, undefined, staff);

    const { transaction, accessToken } = createTransaction({
      pumpId,
      plate: "34FLT001",
      plateSource: "manual",
      fuelType: "benzin",
      amountMode: "liters",
      requestedLiters: 10,
    });
    const updated = payWithFleetAccount(transaction.id, accessToken, fleet.id);
    expect(updated.payment_method).toBe("fleet");
    expect(updated.payment_status).toBe("captured");
    emergencyStopTransaction(transaction.id, staff, "test cleanup");
  });

  it("rejects full_tank mode (real amount unknown upfront, same limitation as discount codes)", () => {
    const { pumpId } = setUpStationForTransactions();
    const station = db.prepare("SELECT station_id FROM pumps WHERE id = ?").get(pumpId) as { station_id: number };
    const staff = createTestUser(null, "admin");
    const fleet = createFleetAccount(station.station_id, { companyName: "Test Filo 2", billingType: "prepaid" }, staff);
    addFleetPlate(station.station_id, fleet.id, "34FLT002");
    topUpFleetAccount(station.station_id, fleet.id, 10000, undefined, staff);

    const { transaction, accessToken } = createTransaction({ pumpId, plate: "34FLT002", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    expect(() => payWithFleetAccount(transaction.id, accessToken, fleet.id)).toThrow();
  });

  it("refunds the fleet charge if the transaction is emergency-stopped before any fuel is dispensed", () => {
    const { pumpId } = setUpStationForTransactions();
    const station = db.prepare("SELECT station_id FROM pumps WHERE id = ?").get(pumpId) as { station_id: number };
    const staff = createTestUser(null, "admin");
    const fleet = createFleetAccount(station.station_id, { companyName: "Test Filo 3", billingType: "prepaid" }, staff);
    addFleetPlate(station.station_id, fleet.id, "34FLT003");
    topUpFleetAccount(station.station_id, fleet.id, 1000, undefined, staff);

    const { transaction, accessToken } = createTransaction({
      pumpId,
      plate: "34FLT003",
      plateSource: "manual",
      fuelType: "benzin",
      amountMode: "liters",
      requestedLiters: 10,
    });
    payWithFleetAccount(transaction.id, accessToken, fleet.id);
    emergencyStopTransaction(transaction.id, staff, "test - stop before any dispensing");

    const account = db.prepare("SELECT balance FROM fleet_accounts WHERE id = ?").get(fleet.id) as { balance: number };
    expect(account.balance).toBe(1000);
  });
});

describe("createTransaction - yanlis yakit sert engelleme (sunucu tarafi)", () => {
  it("'block' modunda, filonun beklediginden farkli yakit turuyle islem olusturulamaz - dogrudan API cagrisi da kiosk kontrolunu atlayamaz", () => {
    const { pumpId } = setUpStationForTransactions();
    const station = db.prepare("SELECT station_id FROM pumps WHERE id = ?").get(pumpId) as { station_id: number };
    createTestFuelPrice(station.station_id, "motorin", 45);
    setTankStock(station.station_id, "motorin", 500);
    const staff = createTestUser(null, "admin");
    const fleet = createFleetAccount(station.station_id, { companyName: "Test Filo Yanlis Yakit", billingType: "prepaid" }, staff);
    addFleetPlate(station.station_id, fleet.id, "34WFB001", "motorin");
    setWrongFuelMode(station.station_id, "block", staff);

    expect(() =>
      createTransaction({ pumpId, plate: "34WFB001", plateSource: "manual", fuelType: "benzin", amountMode: "liters", requestedLiters: 1 })
    ).toThrow();
  });

  it("'block' modunda, beklenenle AYNI yakit turu secilirse islem normal sekilde olusur", () => {
    const { pumpId } = setUpStationForTransactions();
    const station = db.prepare("SELECT station_id FROM pumps WHERE id = ?").get(pumpId) as { station_id: number };
    const staff = createTestUser(null, "admin");
    const fleet = createFleetAccount(station.station_id, { companyName: "Test Filo Dogru Yakit", billingType: "prepaid" }, staff);
    addFleetPlate(station.station_id, fleet.id, "34WFB002", "benzin");
    setWrongFuelMode(station.station_id, "block", staff);

    const { transaction } = createTransaction({ pumpId, plate: "34WFB002", plateSource: "manual", fuelType: "benzin", amountMode: "liters", requestedLiters: 1 });
    expect(transaction.fuel_type).toBe("benzin");
    emergencyStopTransaction(transaction.id, staff, "test cleanup");
  });

  it("varsayilan 'warn' modunda sunucu islemi engellemez - yalnizca kiosk uyarir", () => {
    const { pumpId } = setUpStationForTransactions();
    const station = db.prepare("SELECT station_id FROM pumps WHERE id = ?").get(pumpId) as { station_id: number };
    createTestFuelPrice(station.station_id, "motorin", 45);
    setTankStock(station.station_id, "motorin", 500);
    const staff = createTestUser(null, "admin");
    const fleet = createFleetAccount(station.station_id, { companyName: "Test Filo Warn", billingType: "prepaid" }, staff);
    addFleetPlate(station.station_id, fleet.id, "34WFB003", "motorin");

    const { transaction } = createTransaction({ pumpId, plate: "34WFB003", plateSource: "manual", fuelType: "benzin", amountMode: "liters", requestedLiters: 1 });
    expect(transaction.fuel_type).toBe("benzin");
    emergencyStopTransaction(transaction.id, staff, "test cleanup");
  });
});

describe("plate frequency anomaly detection", () => {
  it("creates a warning alarm once the same plate starts too many transactions in a short window", () => {
    const { pumpId } = setUpStationForTransactions();
    const station = db.prepare("SELECT station_id FROM pumps WHERE id = ?").get(pumpId) as { station_id: number };
    const staff = createTestUser(null, "admin");

    for (let i = 0; i < 3; i++) {
      const { transaction } = createTransaction({ pumpId, plate: "34ANM001", plateSource: "manual", fuelType: "benzin", amountMode: "liters", requestedLiters: 1 });
      emergencyStopTransaction(transaction.id, staff, "test cleanup");
    }

    const alarms = db
      .prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?")
      .all(station.station_id, "plate_frequency_anomaly");
    expect(alarms.length).toBeGreaterThan(0);
  });

  it("does not alarm for a plate with only a couple of transactions", () => {
    const { pumpId } = setUpStationForTransactions();
    const station = db.prepare("SELECT station_id FROM pumps WHERE id = ?").get(pumpId) as { station_id: number };
    const staff = createTestUser(null, "admin");

    const { transaction } = createTransaction({ pumpId, plate: "34ANM002", plateSource: "manual", fuelType: "benzin", amountMode: "liters", requestedLiters: 1 });
    emergencyStopTransaction(transaction.id, staff, "test cleanup");

    const alarms = db
      .prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?")
      .all(station.station_id, "plate_frequency_anomaly");
    expect(alarms.length).toBe(0);
  });
});

describe("emergencyStopStation", () => {
  it("stops the active transaction and faults every pump at the station, including idle ones", () => {
    const { station, pumpId } = setUpStationForTransactions();
    const idlePumpId = createTestPump(station.id, ["benzin"]);
    const staff = createTestUser(null, "admin");

    const { transaction } = createTransaction({ pumpId, plate: "34ACL001", plateSource: "manual", fuelType: "benzin", amountMode: "full_tank" });
    payOk(transaction.id);

    const result = emergencyStopStation(station.id, staff, "Yangin suphesi");
    expect(result.stoppedTransactions).toBe(1);

    const activePump = db.prepare("SELECT * FROM pumps WHERE id = ?").get(pumpId) as { status: string; fault_code: string | null; current_transaction_id: number | null };
    expect(activePump.status).toBe("fault");
    expect(activePump.fault_code).toBe("EMERGENCY_STOP");
    expect(activePump.current_transaction_id).toBeNull();

    const idlePump = db.prepare("SELECT * FROM pumps WHERE id = ?").get(idlePumpId) as { status: string; fault_code: string | null };
    expect(idlePump.status).toBe("fault");
    expect(idlePump.fault_code).toBe("EMERGENCY_STOP");

    const stoppedTransaction = db.prepare("SELECT status FROM transactions WHERE id = ?").get(transaction.id) as { status: string };
    expect(stoppedTransaction.status).toBe("cancelled");

    const alarms = db
      .prepare<[number, string], AlarmRow>("SELECT * FROM alarms WHERE station_id = ? AND type = ?")
      .all(station.id, "emergency_stop");
    expect(alarms.length).toBe(1);
    expect(alarms[0]!.severity).toBe("critical");
  });

  it("faults every pump even when none has an active transaction", () => {
    const { station, pumpId } = setUpStationForTransactions();
    const staff = createTestUser(null, "admin");

    const result = emergencyStopStation(station.id, staff, "Test - islem yokken tetiklendi");
    expect(result.stoppedTransactions).toBe(0);

    const pump = db.prepare("SELECT status FROM pumps WHERE id = ?").get(pumpId) as { status: string };
    expect(pump.status).toBe("fault");
  });
});

describe("iptal edilen islemin odeme durumu", () => {
  function readTransaction(id: number): TransactionRow {
    return db.prepare<[number], TransactionRow>("SELECT * FROM transactions WHERE id = ?").get(id)!;
  }

  it("kart girilmeden iptal edilen islem 'askida' gorunmez", () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction, accessToken } = createTransaction({
      pumpId,
      plate: "06VY894",
      plateSource: "manual",
      fuelType: "benzin",
      amountMode: "amount",
      requestedAmount: 500,
    });

    // Kiosk iyzico formunu acar acmaz payment_status 'processing' olur.
    markIyzicoPending(transaction.id, accessToken, "iyzico-cancel-1");
    const cancelled = cancelPendingTransaction(transaction.id, accessToken, "Musteri vazgecti");

    expect(cancelled.status).toBe("cancelled");
    // Kritik olan bu: 'processing' kalsaydi mutabakattaki "Askida Kalan Islemler"
    // listesi bunu "parasi bloke edilmis" diye gosterirdi. Ortada hic para yok.
    expect(cancelled.payment_status).toBe("cancelled");
    expect(cancelled.total_amount).toBe(0);
  });

  it("zaman asimiyla iptal edilen islemde de odeme durumu kapatilir", () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction, accessToken } = createTransaction({
      pumpId,
      plate: "34XYZ01",
      plateSource: "manual",
      fuelType: "benzin",
      amountMode: "amount",
      requestedAmount: 300,
    });
    markIyzicoPending(transaction.id, accessToken, "iyzico-cancel-2");

    reconcileStaleCreatedTransactions(-1); // her seyi bayat say
    const after = readTransaction(transaction.id);
    expect(after.status).toBe("cancelled");
    expect(after.payment_status).toBe("cancelled");
  });

  it("parasi GERCEKTEN bloke edilmis islemde odeme durumu KORUNUR", () => {
    const { pumpId } = setUpStationForTransactions();
    const { transaction, accessToken } = createTransaction({
      pumpId,
      plate: "35ABC12",
      plateSource: "manual",
      fuelType: "benzin",
      amountMode: "amount",
      requestedAmount: 300,
    });
    db.prepare("UPDATE transactions SET payment_status = 'authorized' WHERE id = ?").run(transaction.id);

    const cancelled = cancelPendingTransaction(transaction.id, accessToken, "Personel iptali");
    // Bloke edilmis para mutabakatta gorunmeye DEVAM etmeli.
    expect(cancelled.payment_status).toBe("authorized");
  });
});

describe("listTransactionsPaged", () => {
  function insertTransaction(stationId: number, pumpId: number, plate: string, at: string): void {
    db.prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
          total_amount, discount_amount, payment_status, status, kiosk_access_token, created_at, completed_at)
       VALUES (?, ?, ?, 'benzin', 'amount', 44.5, 10, 445, 0, 'captured', 'completed', ?, ?, ?)`
    ).run(stationId, pumpId, plate, `tok-${Math.random().toString(16).slice(2)}`, at, at);
  }

  it("plaka ile kismi eslesme yapar (buyuk/kucuk harf ve bosluktan bagimsiz)", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id, ["benzin"]);
    insertTransaction(station.id, pumpId, "34 ABC 01", "2026-01-01T10:00:00.000Z");
    insertTransaction(station.id, pumpId, "06XYZ99", "2026-01-01T11:00:00.000Z");

    const result = listTransactionsPaged(station.id, { plate: "abc" });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.plate).toBe("34 ABC 01");
  });

  it("arama teriminde boslugu silinmis plaka, sutunda boslu kayitla da eslesir", () => {
    // Musteri plakayi bosluksuz yazabilir ("34abc01") - sutunda ("34 ABC 01")
    // boslugun ARAMA TERIMINDEN silinmesi tek basina yetmez, sutundan da
    // silinmeli, aksi halde LIKE hicbir zaman eslesmezdi.
    const station = createTestStation();
    const pumpId = createTestPump(station.id, ["benzin"]);
    insertTransaction(station.id, pumpId, "34 ABC 01", "2026-01-01T10:00:00.000Z");

    const result = listTransactionsPaged(station.id, { plate: "34abc01" });
    expect(result.transactions).toHaveLength(1);
  });

  it("baska istasyonun islemlerini gostermez", () => {
    const stationA = createTestStation();
    const stationB = createTestStation();
    const pumpA = createTestPump(stationA.id, ["benzin"]);
    const pumpB = createTestPump(stationB.id, ["benzin"]);
    insertTransaction(stationA.id, pumpA, "34AAA01", "2026-01-01T10:00:00.000Z");
    insertTransaction(stationB.id, pumpB, "34BBB01", "2026-01-01T10:00:00.000Z");

    const result = listTransactionsPaged(stationA.id, {});
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.plate).toBe("34AAA01");
  });

  it("tarih araligi 'to' gunun sonuna kadar dahil eder", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id, ["benzin"]);
    insertTransaction(station.id, pumpId, "34IN0001", "2026-03-05T23:50:00.000Z");
    insertTransaction(station.id, pumpId, "34OUT001", "2026-03-06T00:10:00.000Z");

    const result = listTransactionsPaged(station.id, { from: "2026-03-01", to: "2026-03-05T23:59:59.999Z" });
    expect(result.transactions.map((t) => t.plate)).toEqual(["34IN0001"]);
  });

  it("total TUM eslesenleri yansitir, sadece o sayfayi degil", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id, ["benzin"]);
    for (let i = 0; i < 5; i++) {
      insertTransaction(station.id, pumpId, `34PAGE0${i}`, `2026-02-0${i + 1}T10:00:00.000Z`);
    }

    const page1 = listTransactionsPaged(station.id, { page: 1, pageSize: 2 });
    expect(page1.transactions).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page3 = listTransactionsPaged(station.id, { page: 3, pageSize: 2 });
    expect(page3.transactions).toHaveLength(1);
    expect(page3.total).toBe(5);
  });

  it("pageSize ve page sinirlarini asamaz", () => {
    const station = createTestStation();
    const pumpId = createTestPump(station.id, ["benzin"]);
    insertTransaction(station.id, pumpId, "34LIMIT1", "2026-04-01T10:00:00.000Z");

    const result = listTransactionsPaged(station.id, { page: -3, pageSize: 5000 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(200);
  });
});
