import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import type { FuelPriceRow, FuelType, TransactionRow, UserRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";
import { getPump, setPumpStatus } from "./pumpService.js";
import { processVirtualPayment, type VirtualCardInput } from "./paymentService.js";
import { createAlarm } from "./alarmService.js";
import { recordAudit } from "./auditService.js";
import { deductAvailable, getAvailableLiters, recordSaleMovement } from "./fuelStockService.js";
import { getDispenserDriver } from "./dispenserDriver.js";
import { capturePostAuth, cancelPreAuthHold } from "./iyzicoService.js";
import { logger } from "../utils/logger.js";
import { safeCompare } from "../utils/safeCompare.js";
import { getBalance as getLoyaltyBalance, getLoyaltyConfig, earnPoints, redeemPoints, refundPoints } from "./loyaltyService.js";
import { validateCode, redeemCode, releaseCode } from "./discountService.js";

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
  return { transaction, accessToken };
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
 * baslatir. Hem `payTransaction` (simule kart) hem de iyzico callback handler'i
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

export function payTransaction(id: number, accessToken: string, card: VirtualCardInput): TransactionRow {
  const t = getTransactionForKiosk(id, accessToken);
  if (t.status !== "created") throw new TransactionError("Bu islem icin odeme alinamaz.", 409);

  const result = processVirtualPayment(card, chargeAmount(t));
  return finalizeTransactionPayment(id, result);
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
    void settleIyzicoPreAuthIfNeeded(completed);
  }, DISPENSE_TICK_MS);

  activeDispensers.set(id, interval);
}

/** Operator tarafindan acil durdurma: dolum kismen tamamlanmis olsa bile o ana kadarki miktar uzerinden islem sonlandirilir. */
export function emergencyStopTransaction(id: number, byUser: UserRow, reason: string): TransactionRow {
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
  }
  void settleIyzicoPreAuthIfNeeded(updated);
  return updated;
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

/** Sunucu yeniden baslatildiginda yarim kalmis dolum simulasyonlarini emniyetli sekilde temizler. */
export function reconcileStuckTransactions(): void {
  const stuck = db
    .prepare<[], TransactionRow>("SELECT * FROM transactions WHERE status IN ('authorized','dispensing')")
    .all();
  for (const t of stuck) {
    touch(t.id, { status: "cancelled", cancelled_reason: "Sunucu yeniden baslatildi." });
    setPumpStatus(t.pump_id, "idle", { currentTransactionId: null });
  }
}
