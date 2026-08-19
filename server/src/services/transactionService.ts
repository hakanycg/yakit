import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import type { FuelPriceRow, FuelType, TransactionRow, UserRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";
import { getPump, setPumpStatus } from "./pumpService.js";
import { processVirtualPayment, type VirtualCardInput } from "./paymentService.js";
import { createAlarm } from "./alarmService.js";
import { recordAudit } from "./auditService.js";

const DISPENSE_TICK_MS = 500;
const FLOW_LITERS_PER_SEC_MIN = 0.45;
const FLOW_LITERS_PER_SEC_MAX = 0.75;
const FULL_TANK_MIN_LITERS = 28;
const FULL_TANK_MAX_LITERS = 55;

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

function hasOpenShift(stationId: number): boolean {
  return !!db.prepare("SELECT 1 FROM shifts WHERE station_id = ? AND ended_at IS NULL LIMIT 1").get(stationId);
}

/**
 * Kiosk satislari hicbir kullanici hesabina dogrudan baglanmaz; Personel Performansi
 * raporu satisi, o an istasyonda acik olan vardiyaya (zaman araligina gore) atfeder.
 * Acik vardiya yokken bir satis tamamlanirsa kimseye yazilmaz ("vardiyasiz satis").
 * Bunu operator/yoneticinin fark etmesi icin bir alarm olusturulur; ayni donemde
 * tekrar tekrar bildirim gitmesin diye zaten aktif boyle bir alarm varsa yenisi
 * acilmaz (bir vardiya acildiginda bu alarm otomatik cozulur, bkz. routes/shifts.ts).
 */
function flagIfUnassignedSale(t: TransactionRow): void {
  if (t.status !== "completed" || hasOpenShift(t.station_id)) return;
  const existing = db
    .prepare("SELECT id FROM alarms WHERE station_id = ? AND type = 'unassigned_sale' AND status != 'resolved' LIMIT 1")
    .get(t.station_id);
  if (existing) return;
  createAlarm({
    stationId: t.station_id,
    pumpId: t.pump_id,
    type: "unassigned_sale",
    severity: "warning",
    message: `Acik vardiya yokken bir satis tamamlandi (Pompa ${t.pump_id}, Plaka ${t.plate}). Personel Performansi raporunda "Vardiyasiz Satislar" altinda gorunur.`,
  });
}

export interface CreateTransactionInput {
  pumpId: number;
  plate: string;
  plateSource: "manual" | "lpr";
  fuelType: FuelType;
  amountMode: "amount" | "liters" | "full_tank";
  requestedAmount?: number;
  requestedLiters?: number;
}

export function createTransaction(input: CreateTransactionInput): { transaction: TransactionRow; accessToken: string } {
  const pump = getPump(input.pumpId);
  if (!pump) throw new TransactionError("Pompa bulunamadi.", 404);
  if (pump.status !== "idle") throw new TransactionError("Pompa su anda musait degil.", 409);

  const fuelTypes = JSON.parse(pump.fuel_types) as string[];
  if (!fuelTypes.includes(input.fuelType)) {
    throw new TransactionError("Bu pompa secilen yakit tipini desteklemiyor.", 400);
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
        : FULL_TANK_MAX_LITERS * price.price_per_liter;

  const accessToken = randomBytes(24).toString("base64url");

  const result = db
    .prepare(
      `INSERT INTO transactions
        (station_id, pump_id, plate, plate_source, fuel_type, amount_mode, requested_amount, requested_liters,
         price_per_liter, total_amount, kiosk_access_token, status, payment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 'pending')`
    )
    .run(
      pump.station_id,
      input.pumpId,
      input.plate.toUpperCase().replace(/\s+/g, " ").trim(),
      input.plateSource,
      input.fuelType,
      input.amountMode,
      input.requestedAmount ?? null,
      input.requestedLiters ?? null,
      price.price_per_liter,
      estimatedTotal,
      accessToken
    );

  const transaction = getTransactionOrThrow(result.lastInsertRowid as number);
  setPumpStatus(pump.id, "reserved", { currentTransactionId: transaction.id });
  broadcastTransaction(transaction);
  return { transaction, accessToken };
}

export function getTransactionForKiosk(id: number, accessToken: string): TransactionRow {
  const t = getTransactionOrThrow(id);
  if (t.kiosk_access_token !== accessToken) throw new TransactionError("Erisim reddedildi.", 403);
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

  const updated = touch(id, {
    payment_status: "captured",
    status: "authorized",
    payment_reference: result.reference,
    started_at: new Date().toISOString(),
  });
  broadcastTransaction(updated);

  startDispensing(id);
  return getTransactionOrThrow(id);
}

export function payTransaction(id: number, accessToken: string, card: VirtualCardInput): TransactionRow {
  const t = getTransactionForKiosk(id, accessToken);
  if (t.status !== "created") throw new TransactionError("Bu islem icin odeme alinamaz.", 409);

  const result = processVirtualPayment(card, t.total_amount);
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
  if (t.payment_method !== "iyzico" || t.payment_reference !== token) {
    throw new TransactionError("iyzico token eslesmedi.", 403);
  }
  return t;
}

function startDispensing(id: number): void {
  const t = getTransactionOrThrow(id);
  if (t.status !== "authorized") return;

  const capLiters = t.amount_mode === "full_tank" ? FULL_TANK_MIN_LITERS + Math.random() * (FULL_TANK_MAX_LITERS - FULL_TANK_MIN_LITERS) : null;
  const targetLiters =
    t.amount_mode === "liters"
      ? t.requested_liters!
      : t.amount_mode === "amount"
        ? t.requested_amount! / t.price_per_liter
        : capLiters!;

  touch(id, { status: "dispensing", dispensed_liters: 0, total_amount: 0 });
  setPumpStatus(t.pump_id, "dispensing", { currentTransactionId: id });

  const interval = setInterval(() => {
    const current = getTransactionOrThrow(id);
    if (current.status !== "dispensing") {
      clearInterval(interval);
      activeDispensers.delete(id);
      return;
    }

    const flowRate = FLOW_LITERS_PER_SEC_MIN + Math.random() * (FLOW_LITERS_PER_SEC_MAX - FLOW_LITERS_PER_SEC_MIN);
    const increment = flowRate * (DISPENSE_TICK_MS / 1000);
    let nextLiters = current.dispensed_liters + increment;
    let finished = false;

    if (nextLiters >= targetLiters) {
      nextLiters = targetLiters;
      finished = true;
    }

    const nextAmount = nextLiters * current.price_per_liter;

    if (!finished) {
      touch(id, { dispensed_liters: nextLiters, total_amount: Math.round(nextAmount * 100) / 100 });
      broadcastTransaction(getTransactionOrThrow(id));
      return;
    }

    clearInterval(interval);
    activeDispensers.delete(id);
    const completed = touch(id, {
      dispensed_liters: nextLiters,
      total_amount: Math.round(nextAmount * 100) / 100,
      status: "completed",
      completed_at: new Date().toISOString(),
    });
    setPumpStatus(current.pump_id, "idle", { currentTransactionId: null });
    broadcastTransaction(completed);
    flagIfUnassignedSale(completed);
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
  const updated = touch(id, {
    status: wasDispensing ? "completed" : "cancelled",
    cancelled_reason: reason,
    completed_at: wasDispensing ? new Date().toISOString() : null,
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
  flagIfUnassignedSale(updated);
  return updated;
}

export function cancelPendingTransaction(id: number, accessToken: string, reason: string): TransactionRow {
  const t = getTransactionForKiosk(id, accessToken);
  if (t.status !== "created") throw new TransactionError("Bu islem artik iptal edilemez.", 409);
  const updated = touch(id, { status: "cancelled", cancelled_reason: reason });
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

export function getTransactionById(id: number): TransactionRow {
  return getTransactionOrThrow(id);
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
