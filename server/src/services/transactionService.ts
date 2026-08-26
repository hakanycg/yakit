import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import type { FuelPriceRow, FuelType, TransactionRow, UserRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";
import { getPump, listPumps, setPumpStatus } from "./pumpService.js";
import { createAlarm } from "./alarmService.js";
import { recordAudit } from "./auditService.js";
import { deductAvailable, getAvailableLiters, recordSaleMovement } from "./fuelStockService.js";
import { getDispenserDriver } from "./dispenserDriver.js";
import { getAutomationDriver } from "./automationDriver.js";
import { capturePostAuth, cancelPreAuthHold } from "./iyzicoService.js";
import { logger } from "../utils/logger.js";
import { safeCompare } from "../utils/safeCompare.js";
import { getBalance as getLoyaltyBalance, getLoyaltyConfig, earnPoints, redeemPoints, refundPoints } from "./loyaltyService.js";
import { validateCode, redeemCode, releaseCode } from "./discountService.js";
import {
  FleetError,
  chargeAccount as chargeFleetAccount,
  getAccountForPlate as getFleetAccountForPlate,
  refundChargeForTransaction as refundFleetChargeForTransaction,
} from "./fleetService.js";

const DISPENSE_TICK_MS = 500;

const activeDispensers = new Map<number, NodeJS.Timeout>();

export class TransactionError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export function serializeTransaction(t: TransactionRow) {
  return {
    id: t.id,
    stationId: t.station_id,
    pumpId: t.pump_id,
    plate: t.plate,
    plateSource: t.plate_source,
    fuelType: t.fuel_type,
    amountMode: t.amount_mode,
    requestedAmount: t.requested_amount,
    requestedLiters: t.requested_liters,
    pricePerLiter: t.price_per_liter,
    dispensedLiters: Math.round(t.dispensed_liters * 1000) / 1000,
    totalAmount: Math.round(t.total_amount * 100) / 100,
    discountCode: t.discount_code,
    discountAmount: Math.round(t.discount_amount * 100) / 100,
    loyaltyPointsRedeemed: t.loyalty_points_redeemed,
    loyaltyPointsEarned: t.loyalty_points_earned,
    chargeAmount: chargeAmount(t),
    paymentMethod: t.payment_method,
    paymentStatus: t.payment_status,
    status: t.status,
    startedAt: t.started_at,
    completedAt: t.completed_at,
    cancelledReason: t.cancelled_reason,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function getFuelPrice(stationId: number, fuelType: FuelType): FuelPriceRow {
  const row = db
    .prepare<[number, string], FuelPriceRow>("SELECT * FROM fuel_prices WHERE station_id = ? AND fuel_type = ?")
    .get(stationId, fuelType);
  if (!row) throw new TransactionError("Gecersiz yakit tipi.", 400);
  return row;
}

function getTransactionOrThrow(id: number): TransactionRow {
  const row = db.prepare<[number], TransactionRow>("SELECT * FROM transactions WHERE id = ?").get(id);
  if (!row) throw new TransactionError("Islem bulunamadi.", 404);
  return row;
}

function touch(id: number, fields: Record<string, unknown>): TransactionRow {
  const keys = Object.keys(fields);
  const setClause = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  db.prepare(`UPDATE transactions SET ${setClause} WHERE id = ?`).run(...keys.map((k) => fields[k]), new Date().toISOString(), id);
  return getTransactionOrThrow(id);
}

function broadcastTransaction(t: TransactionRow): void {
  broadcast(`transaction:${t.id}`, serializeTransaction(t));
  broadcast(`transactions:${t.station_id}`, serializeTransaction(t));
}

export interface CreateTransactionInput {
  pumpId: number;
  plate: string;
  plateSource: "manual" | "lpr";
  fuelType: FuelType;
  amountMode: "amount" | "liters" | "full_tank";
  requestedAmount?: number;
  requestedLiters?: number;
  discountCode?: string;
  redeemPoints?: number;
}

/** Islem "created" durumundayken (odeme hic alinmadan) iptal/basarisiz olursa, rezerve edilmis
 * indirim kodu kullanimini ve dusulen sadakat puanini musteriye iade eder. */
function refundReservations(t: TransactionRow): void {
  if (t.discount_code) releaseCode(t.station_id, t.discount_code);
  if (t.loyalty_points_redeemed > 0) refundPoints(t.station_id, t.plate, t.loyalty_points_redeemed, t.id);
}

export function createTransaction(input: CreateTransactionInput): { transaction: TransactionRow; accessToken: string } {
  const pump = getPump(input.pumpId);
  if (!pump) throw new TransactionError("Pompa bulunamadi.", 404);
  if (pump.status !== "idle") throw new TransactionError("Pompa su anda musait degil.", 409);

  const fuelTypes = JSON.parse(pump.fuel_types) as string[];
  if (!fuelTypes.includes(input.fuelType)) {
    throw new TransactionError("Bu pompa secilen yakit tipini desteklemiyor.", 400);
  }

  if (getAvailableLiters(pump.station_id, input.fuelType) <= 0) {
    throw new TransactionError("Bu yakit tipi su anda tukenmis. Lutfen istasyon gorevlisiyle iletisime gecin.", 409);
  }

  const price = getFuelPrice(pump.station_id, input.fuelType);

  if (input.amountMode === "amount" && (!input.requestedAmount || input.requestedAmount <= 0)) {
    throw new TransactionError("Gecerli bir tutar giriniz.", 400);
  }
  if (input.amountMode === "liters" && (!input.requestedLiters || input.requestedLiters <= 0)) {
    throw new TransactionError("Gecerli bir litre miktari giriniz.", 400);
  }

  const estimatedTotal =
    input.amountMode === "amount"
      ? input.requestedAmount!
      : input.amountMode === "liters"
        ? input.requestedLiters! * price.price_per_liter
        : getDispenserDriver().estimateMaxFullTankLiters() * price.price_per_liter;

  const normalizedPlate = input.plate.toUpperCase().replace(/\s+/g, " ").trim();

  // Indirim kodu/sadakat puani on-dogrulamasi: yan etkisiz (kullanim sayaci/puan henuz
  // dusulmez), gecersizse islem hic olusturulmadan hata firlatilir.
  let normalizedCode: string | null = null;
  let codeDiscount = 0;
  if (input.discountCode) {
    const { row, discountAmount } = validateCode(pump.station_id, input.discountCode, input.fuelType, estimatedTotal);
    normalizedCode = row.code;
    codeDiscount = discountAmount;
  }

  const redeemPointsAmount = input.redeemPoints && input.redeemPoints > 0 ? Math.round(input.redeemPoints * 100) / 100 : 0;
  let pointsDiscount = 0;
  if (redeemPointsAmount > 0) {
    const balance = getLoyaltyBalance(pump.station_id, normalizedPlate);
    if (redeemPointsAmount > balance) throw new TransactionError("Yetersiz sadakat puani.", 409);
    const { pointValueTry } = getLoyaltyConfig(pump.station_id);
    pointsDiscount = Math.round(redeemPointsAmount * pointValueTry * 100) / 100;
  }

  const discountAmount = Math.min(estimatedTotal, Math.round((codeDiscount + pointsDiscount) * 100) / 100);
  const accessToken = randomBytes(24).toString("base64url");

  const transaction = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO transactions
          (station_id, pump_id, plate, plate_source, fuel_type, amount_mode, requested_amount, requested_liters,
           price_per_liter, total_amount, kiosk_access_token, status, payment_status, discount_code, discount_amount, loyalty_points_redeemed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 'pending', ?, ?, ?)`
      )
      .run(
        pump.station_id,
        input.pumpId,
        normalizedPlate,
        input.plateSource,
        input.fuelType,
        input.amountMode,
        input.requestedAmount ?? null,
        input.requestedLiters ?? null,
        price.price_per_liter,
        estimatedTotal,
        accessToken,
        normalizedCode,
        discountAmount,
        redeemPointsAmount
      );

    const txId = result.lastInsertRowid as number;
    // Kod kullanimi/puan dusumu, satir eklendikten sonra (kayit id'sine referans verebilmek
    // icin) ama hala ayni DB islemi icinde yapilir - herhangi biri (ör. es zamanli baska bir
    // istekle bakiyenin tukenmesi) basarisiz olursa tum ekleme geri alinir.
    if (normalizedCode) redeemCode(pump.station_id, normalizedCode);
    if (redeemPointsAmount > 0) redeemPoints(pump.station_id, normalizedPlate, redeemPointsAmount, txId);

    return getTransactionOrThrow(txId);
  })();

  setPumpStatus(pump.id, "reserved", { currentTransactionId: transaction.id });
  broadcastTransaction(transaction);
  checkPlateFrequencyAnomaly(pump.station_id, normalizedPlate, pump.id);
  return { transaction, accessToken };
}

const PLATE_FREQUENCY_WINDOW_MS = 30 * 60 * 1000;
const PLATE_FREQUENCY_THRESHOLD = 3;

/**
 * Dolandiricilik/anormal davranis tespiti: kart bilgisi saklanmadigi icin "ayni kart
 * farkli plakalarda" gibi bir sinyal kullanilamiyor (bkz. arastirma) - bunun yerine
 * elimizdeki tek gercek sinyal kullanilir: AYNI PLAKA kisa surede (30 dakika) tekrar
 * tekrar islem baslatiyorsa (basarili/iptal fark etmeksizin) bu, operatorun goz atmasi
 * gereken bir siklik anormalligidir - kesin bir dolandiricilik kaniti degildir.
 */
function checkPlateFrequencyAnomaly(stationId: number, plate: string, pumpId: number): void {
  const cutoff = new Date(Date.now() - PLATE_FREQUENCY_WINDOW_MS).toISOString();
  const row = db
    .prepare<[number, string, string], { count: number }>(
      "SELECT COUNT(*) as count FROM transactions WHERE station_id = ? AND plate = ? AND created_at >= ?"
    )
    .get(stationId, plate, cutoff)!;
  if (row.count < PLATE_FREQUENCY_THRESHOLD) return;
  createAlarm({
    stationId,
    pumpId,
    type: "plate_frequency_anomaly",
    severity: "warning",
    message: `Plaka ${plate}, son 30 dakikada ${row.count}. kez islem baslatti - anormal siklik, kontrol edilmesi onerilir.`,
  });
}

export function getTransactionForKiosk(id: number, accessToken: string): TransactionRow {
  const t = getTransactionOrThrow(id);
  if (!safeCompare(t.kiosk_access_token, accessToken)) throw new TransactionError("Erisim reddedildi.", 403);
  return t;
}

export interface PaymentOutcome {
  success: boolean;
  reference: string;
  message: string;
}

/**
 * Odeme sonucunu (simule sanal kart veya gercek iyzico dogrulamasi) islem kaydina
 * isler: basarisizsa pompayi serbest birakip alarm olusturur, basarili ise dolumu
 * baslatir. Hem iyzico callback handler'i hem de filo hesabi odemesi
 * bu tek fonksiyonu kullanir; boylece iki odeme yolu arasinda mantik tekrari olmaz.
 */
export function finalizeTransactionPayment(id: number, result: PaymentOutcome): TransactionRow {
  const t = getTransactionOrThrow(id);
  if (t.status !== "created") throw new TransactionError("Bu islem icin odeme sonucu islenemez.", 409);

  if (!result.success) {
    refundReservations(t);
    const updated = touch(id, {
      payment_status: "failed",
      status: "failed",
      payment_reference: result.reference,
      cancelled_reason: result.message,
    });
    setPumpStatus(t.pump_id, "idle", { currentTransactionId: null });
    createAlarm({
      stationId: t.station_id,
      pumpId: t.pump_id,
      type: "payment_failed",
      severity: "warning",
      message: `Odeme reddedildi (Pompa ${t.pump_id}, Plaka ${t.plate}): ${result.message}`,
    });
    broadcastTransaction(updated);
    return updated;
  }

  // "Depoyu Doldur" + iyzico'da gercek tutar dolum bitmeden bilinemez - bu yuzden burada
  // TAHSILAT degil, yalnizca ON-PROVIZYON (hold) tamamlanmis olur. Gercek tahsilat, dolum
  // bitip kesin tutar belli olunca settleIyzicoPreAuthIfNeeded() ile yapilir (bkz. asagida).
  // Diger tum durumlarda (amount/liters modu, veya sanal kart) tutar zaten baştan kesindir,
  // dogrudan tahsilat ("captured") dogru davranistir.
  const isFullTankIyzicoPreAuth = t.amount_mode === "full_tank" && t.payment_method === "iyzico";
  const updated = touch(id, {
    payment_status: isFullTankIyzicoPreAuth ? "authorized" : "captured",
    status: "authorized",
    payment_reference: result.reference,
    started_at: new Date().toISOString(),
  });
  broadcastTransaction(updated);

  startDispensing(id);
  return getTransactionOrThrow(id);
}

/**
 * "Depoyu Doldur" + iyzico ile odenmis (on-provizyon/hold ile tutulan) bir islemi kapatir:
 * gercekten yakit verildiyse (dispensed_liters > 0) yalnizca GERCEK tutari tahsil eder
 * (capture) - bloke edilenin farki bankada otomatik serbest kalir. Hic yakit verilmediyse
 * (0 litre) blokajin TAMAMINI sifir tahsilatla serbest birakir. Diger tum durumlarda
 * (amount/liters modu, veya sanal kart) hicbir sey yapmaz - o akislarda tahsilat zaten
 * gercek tutardir, ayrica bir kapama adimina gerek yoktur.
 *
 * Ateşle-ve-unut (fire-and-forget) olarak cagrilir: musteri pompadan ayrilmis olabilecegi
 * icin bu adimin islem akisini bloklamasi/basarisiz olursa akisi durdurmasi dogru olmaz.
 * Basarisizlik durumunda kritik bir alarm olusturulur - istasyon personeli iyzico panelinden
 * manuel mudahale etmelidir.
 */
async function settleIyzicoPreAuthIfNeeded(t: TransactionRow): Promise<void> {
  if (t.amount_mode !== "full_tank" || t.payment_method !== "iyzico" || t.payment_status !== "authorized") return;
  if (!t.payment_reference) return;

  try {
    if (t.dispensed_liters > 0) {
      const captured = chargeAmount(t);
      await capturePostAuth(t.station_id, t.id, t.payment_reference, captured);
      touch(t.id, { payment_status: "captured" });
      logger.info({ transactionId: t.id, capturedAmount: captured }, "iyzico on-provizyon gercek tutar uzerinden kapatildi (postAuth).");
    } else {
      await cancelPreAuthHold(t.station_id, t.id, t.payment_reference);
      touch(t.id, { payment_status: "voided" });
      logger.info({ transactionId: t.id }, "iyzico on-provizyon blokaji sifir tahsilatla serbest birakildi (cancel).");
    }
  } catch (err) {
    logger.error({ err, transactionId: t.id }, "iyzico on-provizyon kapama/iptal islemi basarisiz - manuel mudahale gerekiyor.");
    createAlarm({
      stationId: t.station_id,
      type: "payment_settlement_failed",
      severity: "critical",
      message: `Islem #${t.id} (Plaka ${t.plate}) icin iyzico on-provizyon kapama/iptal islemi basarisiz oldu - iyzico panelinden manuel kontrol edilmesi gerekiyor.`,
    });
  }
}

/** Musteriden gercekte tahsil edilecek tutar: total_amount (yakit degeri, raporlama icin
 * degismeden kalir) eksi indirim kodu/sadakat puani indirimidir. */
export function chargeAmount(t: TransactionRow): number {
  return Math.max(0, Math.round((t.total_amount - t.discount_amount) * 100) / 100);
}

/**
 * Gercekten dagitilan yakit miktari kesinlestigi HER iki noktada (normal bitis VE
 * emergencyStopTransaction ile erken kesilme) IOS otomasyon surucusune bildirir - EPDK
 * raporlamasi indirim/sadakat oncesi GERCEK yakit degerini (total_amount) gerektirir,
 * chargeAmount() (musteriden tahsil edilen net tutar) degil.
 */
function reportAutomationSale(t: TransactionRow): void {
  getAutomationDriver().reportSaleCompleted({
    transactionId: t.id,
    stationId: t.station_id,
    pumpId: t.pump_id,
    plate: t.plate,
    fuelType: t.fuel_type,
    liters: t.dispensed_liters,
    amount: t.total_amount,
    pricePerLiter: t.price_per_liter,
    completedAt: t.completed_at ?? new Date().toISOString(),
  });
}

/**
 * Filo/kurumsal hesap ile odeme: kart bilgisi toplanmaz, tutar dogrudan sirketin
 * bakiyesinden/kredi limitinden dusulur. "Depoyu Doldur" modunda gercek tutar dolum
 * bitmeden bilinemedigi icin (bkz. iyzico on-provizyon yorumu) bu odeme yontemi
 * yalnizca tutari BASTAN KESIN bilinen modlarda (amount/liters) sunulur.
 */
export function payWithFleetAccount(id: number, accessToken: string, fleetAccountId: number): TransactionRow {
  const t = getTransactionForKiosk(id, accessToken);
  if (t.status !== "created") throw new TransactionError("Bu islem icin odeme alinamaz.", 409);
  if (t.amount_mode === "full_tank") throw new TransactionError("Filo hesabi ile odeme, 'Depoyu Doldur' modunda kullanilamaz.", 409);

  const account = getFleetAccountForPlate(t.station_id, t.plate);
  if (!account || account.id !== fleetAccountId) throw new TransactionError("Bu plaka icin gecerli bir filo hesabi bulunamadi.", 403);

  try {
    chargeFleetAccount(t.station_id, fleetAccountId, chargeAmount(t), id);
  } catch (err) {
    if (err instanceof FleetError) throw new TransactionError(err.message, err.status);
    throw err;
  }
  touch(id, { payment_method: "fleet" });
  return finalizeTransactionPayment(id, { success: true, reference: `FLEET-${fleetAccountId}`, message: "Filo hesabindan tahsil edildi." });
}

/** Kiosk iyzico odeme formuna yonlendirmeden once, islemi "iyzico odemesi bekleniyor" durumuna alir. */
export function markIyzicoPending(id: number, accessToken: string, token: string): TransactionRow {
  const t = getTransactionForKiosk(id, accessToken);
  if (t.status !== "created") throw new TransactionError("Bu islem icin odeme baslatilamaz.", 409);
  const updated = touch(id, { payment_method: "iyzico", payment_status: "processing", payment_reference: token });
  broadcastTransaction(updated);
  return updated;
}

/** iyzico callback'inin, o an islem uzerinde bekleyen token ile eslesip eslesmedigini dogrular. */
export function getTransactionForIyzicoCallback(id: number, token: string): TransactionRow {
  const t = getTransactionOrThrow(id);
  if (t.payment_method !== "iyzico" || !t.payment_reference || !safeCompare(t.payment_reference, token)) {
    throw new TransactionError("iyzico token eslesmedi.", 403);
  }
  return t;
}

/**
 * Islem, zaman asimi (reconcileStaleCreatedTransactions) veya musterinin kendi iptaliyle
 * "cancelled"/"failed" durumuna dusurulduKTEN SONRA, musteri iyzico'nun sayfasinda (SMS/3D
 * Secure gecikmesiyle) odemeyi YINE DE tamamlamis olabilir - iyzico bu gec gelen sonucu bize
 * callback ile bildirir. Bunu sessizce yok saymak (eski davranis) musteriden PARA ALINMIS
 * ama yakit VERILMEMIS bir durumu fark edilmeden birakir. Bu fonksiyon o riski kapatir: gec
 * gelen basarili odemeyi tespit edip mumkunse otomatik geri alir (on-provizyon/full_tank
 * modunda), degilse (dogrudan tahsilat) personelin manuel iade yapmasi icin KRITIK bir alarm
 * dusurur - hicbir sekilde sessizce kaybolmaz.
 */
export async function handleLatePaymentAfterCancellation(t: TransactionRow, paymentId: string | null): Promise<void> {
  const isPreAuth = t.amount_mode === "full_tank";
  let autoReversed = false;
  let reverseError: string | null = null;

  if (isPreAuth && paymentId) {
    try {
      await cancelPreAuthHold(t.station_id, t.id, paymentId);
      autoReversed = true;
    } catch (err) {
      reverseError = err instanceof Error ? err.message : String(err);
    }
  }

  const amountText = `${chargeAmount(t).toFixed(2)} TL`;
  const message = isPreAuth
    ? autoReversed
      ? `Islem #${t.id} (Plaka ${t.plate}) zaman asimiyla iptal edildikten SONRA odeme iyzico'da basarili oldu - on-provizyon otomatik iptal edildi, musteriden para cekilmedi.`
      : `Islem #${t.id} (Plaka ${t.plate}) zaman asimiyla iptal edildikten SONRA odeme iyzico'da basarili oldu - on-provizyon OTOMATIK IPTAL EDILEMEDI (${reverseError}). ACILEN iyzico panelinden manuel iptal edin.`
    : `Islem #${t.id} (Plaka ${t.plate}, ${amountText}) zaman asimiyla iptal edildikten SONRA odeme iyzico'da basarili oldu - bu DOGRUDAN BIR TAHSILATTIR, otomatik iade altyapisi henuz yok. ACILEN iyzico panelinden musteriye manuel iade yapin.`;

  logger.error({ transactionId: t.id, isPreAuth, autoReversed, paymentId }, "Gec gelen basarili iyzico odemesi tespit edildi.");
  createAlarm({
    stationId: t.station_id,
    pumpId: t.pump_id,
    type: "late_payment_after_cancel",
    severity: "critical",
    message,
  });
}

function startDispensing(id: number): void {
  const t = getTransactionOrThrow(id);
  if (t.status !== "authorized") return;

  const driver = getDispenserDriver();
  // full_tank modunda hedef, gercek donanimda ONCEDEN bilinemeyebilir (bkz. DispenserDriver
  // yorumu) - bu durumda targetLiters null kalir ve dolum yalnizca tick()'in
  // nozzleStopped=true dondurdugu anda (veya depo tukendiginde) biter.
  const targetLiters: number | null =
    t.amount_mode === "liters"
      ? t.requested_liters!
      : t.amount_mode === "amount"
        ? t.requested_amount! / t.price_per_liter
        : driver.pickFullTankTargetLiters();

  touch(id, { status: "dispensing", dispensed_liters: 0, total_amount: 0 });
  setPumpStatus(t.pump_id, "dispensing", { currentTransactionId: id });
  getAutomationDriver().reportDispenseStart(t.station_id, t.pump_id, id);

  const interval = setInterval(() => {
    const current = getTransactionOrThrow(id);
    if (current.status !== "dispensing") {
      clearInterval(interval);
      activeDispensers.delete(id);
      return;
    }

    const tick = driver.tick(DISPENSE_TICK_MS);
    const remainingToTarget = targetLiters !== null ? targetLiters - current.dispensed_liters : Infinity;
    const desiredIncrement = Math.max(0, Math.min(tick.liters, remainingToTarget));

    // Gercek fiziksel pompa gibi, dolum ANLIK olarak tanktan besleniyor — depo bu
    // ana kadar bosaldiysa (ör. ayni tanki paylasan baska bir pompa tuketmis olabilir)
    // istenen kadar degil, tankta gercekten kalan kadar dusum yapilir.
    const { actual: actualIncrement, limited: ranDry } = deductAvailable(current.station_id, current.fuel_type, desiredIncrement);

    let nextLiters = current.dispensed_liters + actualIncrement;
    const reachedTarget = targetLiters !== null && nextLiters >= targetLiters - 0.0001;
    const finished = reachedTarget || ranDry || tick.nozzleStopped;
    if (targetLiters !== null && finished) nextLiters = Math.min(nextLiters, targetLiters);

    const nextAmount = nextLiters * current.price_per_liter;

    if (!finished) {
      touch(id, { dispensed_liters: nextLiters, total_amount: Math.round(nextAmount * 100) / 100 });
      broadcastTransaction(getTransactionOrThrow(id));
      return;
    }

    clearInterval(interval);
    activeDispensers.delete(id);
    const pointsEarned = earnPoints(current.station_id, current.plate, nextLiters, id);
    const completed = touch(id, {
      dispensed_liters: nextLiters,
      total_amount: Math.round(nextAmount * 100) / 100,
      status: "completed",
      completed_at: new Date().toISOString(),
      cancelled_reason: ranDry ? "Depo dolum sirasinda tukendi; islem eldeki miktarla sonuclandirildi." : null,
      loyalty_points_earned: pointsEarned,
    });
    setPumpStatus(current.pump_id, "idle", { currentTransactionId: null });
    broadcastTransaction(completed);
    recordSaleMovement(completed.station_id, completed.fuel_type, completed.dispensed_liters, completed.id);
    reportAutomationSale(completed);
    void settleIyzicoPreAuthIfNeeded(completed);
  }, DISPENSE_TICK_MS);

  activeDispensers.set(id, interval);
}

/** Operator tarafindan acil durdurma: dolum kismen tamamlanmis olsa bile o ana kadarki miktar uzerinden islem sonlandirilir. */
export function emergencyStopTransaction(id: number, byUser: UserRow | null, reason: string): TransactionRow {
  const t = getTransactionOrThrow(id);
  if (t.status !== "dispensing" && t.status !== "authorized" && t.status !== "created") {
    throw new TransactionError("Islem zaten sonlanmis.", 409);
  }

  const interval = activeDispensers.get(id);
  if (interval) {
    clearInterval(interval);
    activeDispensers.delete(id);
  }

  const wasDispensing = t.status === "dispensing" && t.dispensed_liters > 0;
  // Odeme hic alinmamis (status "created") bir islem iptal ediliyorsa, rezerve edilmis
  // indirim kodu/sadakat puani iade edilir - musteri bunlar icin hicbir sey odemedi.
  if (t.status === "created") refundReservations(t);
  const updated = touch(id, {
    status: wasDispensing ? "completed" : "cancelled",
    cancelled_reason: reason,
    completed_at: wasDispensing ? new Date().toISOString() : null,
    // Hic yakit verilmediyse (0 litre) tutar da sifir olmalidir - aksi halde "Depoyu Doldur"
    // icin baslangicta yazilmis TAHMINI tutar (ör. 2447,50 TL), gercekte hicbir sey
    // dagitilmamis olsa bile islem gecmisinde oyle kalirdi. `touch()` Object.keys() ile tum
    // alanlari (undefined dahil) SQL parametresine baglamaya calisip better-sqlite3'te hataya
    // yol acacagindan, bu alan wasDispensing=true iken NESNEYE HIC EKLENMIYOR.
    ...(wasDispensing ? {} : { total_amount: 0 }),
  });
  setPumpStatus(t.pump_id, "idle", { currentTransactionId: null });
  recordAudit({
    user: byUser,
    action: "transaction_emergency_stop",
    entityType: "transaction",
    entityId: id,
    details: { reason },
    stationId: t.station_id,
  });
  broadcastTransaction(updated);
  if (updated.status === "completed") {
    // Tank stogu zaten dolum sirasinda tick tick dusulmustu (deductAvailable);
    // burada sadece o ana kadar dagitilan miktar icin ozet hareket kaydediliyor.
    recordSaleMovement(updated.station_id, updated.fuel_type, updated.dispensed_liters, updated.id);
    reportAutomationSale(updated);
  }
  void settleIyzicoPreAuthIfNeeded(updated);
  refundFleetChargeIfNeeded(t, wasDispensing);
  return updated;
}

/**
 * Yangin/dokulme gibi acil bir durumda istasyondaki TUM pompalari tek seferde
 * devre disi birakir - tekli emergencyStopTransaction'in aksine, aktif islemi
 * olmayan bosta (idle) pompalari da "fault" durumuna alir, boylece hicbir yeni
 * islem baslatilamaz. Gorevli fiziksel olarak mudahale edip durumu netlestirene
 * kadar istasyon tamamen kapali kalir.
 */
export function emergencyStopStation(stationId: number, byUser: UserRow | null, reason: string): { stoppedTransactions: number } {
  const pumps = listPumps(stationId);
  let stoppedTransactions = 0;

  for (const pump of pumps) {
    if (pump.current_transaction_id) {
      try {
        emergencyStopTransaction(pump.current_transaction_id, byUser, reason);
        stoppedTransactions += 1;
      } catch (err) {
        if (!(err instanceof TransactionError)) throw err;
      }
    }
    setPumpStatus(pump.id, "fault", { faultCode: "EMERGENCY_STOP", faultMessage: reason, currentTransactionId: null });
  }

  const triggeredBy = byUser ? byUser.display_name : "Otomatik guvenlik sistemi";
  createAlarm({
    stationId,
    type: "emergency_stop",
    severity: "critical",
    message: `Istasyon geneli acil durdurma tetiklendi (${triggeredBy}): ${reason}`,
  });
  recordAudit({
    user: byUser,
    action: "station_emergency_stop",
    entityType: "station",
    entityId: stationId,
    details: { reason, stoppedTransactions, pumpCount: pumps.length },
    stationId,
  });

  return { stoppedTransactions };
}

/** Filo hesabindan tahsil edilmis ama hic yakit dagitilmadan durdurulan bir islemde tahsilati geri alir. */
function refundFleetChargeIfNeeded(t: TransactionRow, wasDispensing: boolean): void {
  if (wasDispensing || t.status === "created" || t.payment_method !== "fleet") return;
  try {
    refundFleetChargeForTransaction(t.id);
  } catch (err) {
    logger.error({ err, transactionId: t.id }, "Filo hesabi tahsilat iadesi basarisiz.");
  }
}

export function cancelPendingTransaction(id: number, accessToken: string, reason: string): TransactionRow {
  const t = getTransactionForKiosk(id, accessToken);
  if (t.status !== "created") throw new TransactionError("Bu islem artik iptal edilemez.", 409);
  refundReservations(t);
  // Odeme hic alinmamisti (status "created") - dagitilan miktar da sifir, dolayisiyla tutar da
  // sifir olmalidir (bkz. emergencyStopTransaction'daki ayni duzeltme).
  const updated = touch(id, { status: "cancelled", cancelled_reason: reason, total_amount: 0 });
  setPumpStatus(t.pump_id, "idle", { currentTransactionId: null });
  broadcastTransaction(updated);
  return updated;
}

export function listTransactions(
  stationId: number,
  filters: { status?: string; from?: string; to?: string; limit?: number }
): TransactionRow[] {
  const clauses: string[] = ["station_id = ?"];
  const params: unknown[] = [stationId];
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.from) {
    clauses.push("created_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("created_at <= ?");
    params.push(filters.to);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const limit = Math.min(filters.limit ?? 200, 1000);
  return db.prepare<unknown[], TransactionRow>(`SELECT * FROM transactions ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
}

/** Istasyon kapsamli tekil islem sorgusu (IDOR korumali - baska istasyonun islemi 404 doner). */
export function getTransactionById(id: number, stationId: number): TransactionRow {
  const t = getTransactionOrThrow(id);
  if (t.station_id !== stationId) throw new TransactionError("Islem bulunamadi.", 404);
  return t;
}

/**
 * Yanlis yakit onleme: bu plaka bu istasyonda daha once basariyla dolum yaptiysa, en
 * son kullandigi yakit turunu doner (yoksa null). Gercek ruhsat/tescil verisine
 * (resmi bir kaynaga) erisimimiz olmadigi icin bu, aracin motor tipinin pratikte
 * neredeyse hic degismemesi varsayimina dayanan bir sezgiseldir - kesin bir dogrulama
 * degildir, sadece musteriye "emin misiniz?" diye sormak icin bir sinyaldir.
 */
export function getLastFuelTypeForPlate(stationId: number, plate: string): FuelType | null {
  const normalized = plate.toUpperCase().replace(/\s+/g, " ").trim();
  const row = db
    .prepare<[number, string], { fuel_type: FuelType }>(
      "SELECT fuel_type FROM transactions WHERE station_id = ? AND plate = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1"
    )
    .get(stationId, normalized);
  return row?.fuel_type ?? null;
}

/**
 * Sunucu yeniden baslatildiginda yarim kalmis dolum simulasyonlarini emniyetli sekilde
 * temizler. emergencyStopTransaction() ile AYNI mantik: gercekten yakit verildiyse
 * (dispensed_liters > 0) "completed" olarak sonuclandirilir (musteri gercek fuel aldi,
 * bunun karsiligi tahsil edilmeli - bkz. asagida), hic verilmediyse "cancelled" olur ve
 * tutar sifirlanir. full_tank + iyzico ile odenmis (on-provizyon/hold ile tutulan) bir
 * islem bu sekilde yarim kalirsa, blokaj hicbir zaman kapatilmaz/serbest birakilmazdi -
 * bu yuzden burada da settleIyzicoPreAuthIfNeeded() cagrilir (ateşle-ve-unut).
 */
export function reconcileStuckTransactions(): void {
  const stuck = db
    .prepare<[], TransactionRow>("SELECT * FROM transactions WHERE status IN ('authorized','dispensing')")
    .all();
  for (const t of stuck) {
    const wasDispensing = t.status === "dispensing" && t.dispensed_liters > 0;
    const updated = touch(t.id, {
      status: wasDispensing ? "completed" : "cancelled",
      cancelled_reason: "Sunucu yeniden baslatildi.",
      completed_at: wasDispensing ? new Date().toISOString() : null,
      ...(wasDispensing ? {} : { total_amount: 0 }),
    });
    setPumpStatus(t.pump_id, "idle", { currentTransactionId: null });
    if (wasDispensing) {
      recordSaleMovement(updated.station_id, updated.fuel_type, updated.dispensed_liters, updated.id);
    }
    void settleIyzicoPreAuthIfNeeded(updated);
    refundFleetChargeIfNeeded(t, wasDispensing);
  }
}

/**
 * Musteri bir islem baslatip (pompa "reserved" olur) odemeyi hic tamamlamadan
 * kiosk'tan ayrilirsa (sekmeyi kapatir, uzaklasir, vb.) - "Islemi Iptal Et"
 * butonuna basmadigi surece transactions.status "created" olarak sonsuza dek
 * kalir ve pompa hicbir zaman "idle"'a donmezdi (bir sonraki musteri o pompayi
 * KULLANAMAZDI, operator elle Reset basana kadar). Bu, belirli bir sureden
 * (maxAgeMs) daha eski hala "created" durumundaki islemleri, gercek bir odeme
 * hic alinmamis gibi (rezerve edilmis indirim kodu/puan iade edilerek) iptal
 * edip pompayi serbest birakir. Sunucu tarafinda periyodik olarak cagrilir
 * (bkz. index.ts) - client-side idle-reset (useIdleReset) sadece kiosk
 * ekranini sifirlar, sunucudaki kaydi/pompayi etkilemez.
 *
 * Varsayilan 3 dakika, iyzico SMS/3D Secure gecikmesi + musterinin kodu
 * bulup girmesi icin makul bir pay birakirken pompayi cok uzun sure kilitli
 * tutmaz. Bunu tek basina daha da agresiflestirmek (ör. 60 saniye) tehlikelidir:
 * musteri gercekten odemeyi tamamlayip iyzico'dan BASARILI sonuc donebilir ama
 * biz o ana kadar islemi zaten iptal etmis oluruz - "musteriden para alindi
 * ama yakit verilmedi" riski. Bu risk artik guvenlik agiyla kapatilmis
 * durumda: gec gelen basarili odemeler sessizce kaybolmaz, tespit edilip
 * mumkunse geri alinir/personele KRITIK alarmla bildirilir (bkz.
 * handleLatePaymentAfterCancellation, kiosk.ts'teki callback rotasi).
 */
export function reconcileStaleCreatedTransactions(maxAgeMs = 3 * 60 * 1000): void {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = db
    .prepare<[string], TransactionRow>("SELECT * FROM transactions WHERE status = 'created' AND created_at < ?")
    .all(cutoff);
  for (const t of stale) {
    refundReservations(t);
    const updated = touch(t.id, {
      status: "cancelled",
      cancelled_reason: "Odeme suresi doldu (musteri islemi tamamlamadi).",
      total_amount: 0,
    });
    setPumpStatus(t.pump_id, "idle", { currentTransactionId: null });
    broadcastTransaction(updated);
  }
}
