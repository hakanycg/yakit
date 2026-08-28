import { db } from "../db/index.js";
import type { FuelOrderRow, FuelSupplierRow, FuelType, UserRow } from "../db/types.js";
import { logger } from "../utils/logger.js";
import { sendEmail } from "./notificationService.js";
import { FUEL_TYPES, FuelStockError, addStock, listTanks } from "./fuelStockService.js";

/**
 * Yakit siparisi: dusuk stok alarmi ile teslimat kaydi arasindaki eksik halka.
 *
 * Alarm caliyordu, sonra biri dagiticiyi telefonla ariyordu; ne siparis verildigi ne de
 * ne zaman beklendigi hicbir yerde durmuyordu. Tanker geldiginde de teslimatin hangi
 * siparise karsilik geldigi bilinmiyordu.
 *
 * Siparis OTOMATIK OLUSTURULMAZ. Sistem yalnizca ONERIR (bkz. suggestions): siparis
 * vermek para taahhut etmektir ve isletmenin karidir. Ayni felsefe filo bakiye yukleme
 * talebinde de var - sistem hazirlar, insan taahhut eder.
 */

export class FuelOrderError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

const FUEL_LABELS: Record<string, string> = { benzin: "Benzin", motorin: "Motorin", lpg: "LPG" };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Tedarikciler -----------------------------------------------------------

export function listSuppliers(stationId: number): FuelSupplierRow[] {
  return db
    .prepare<[number], FuelSupplierRow>("SELECT * FROM fuel_suppliers WHERE station_id = ? ORDER BY active DESC, name")
    .all(stationId);
}

export function getSupplier(stationId: number, id: number): FuelSupplierRow {
  const row = db
    .prepare<[number, number], FuelSupplierRow>("SELECT * FROM fuel_suppliers WHERE id = ? AND station_id = ?")
    .get(id, stationId);
  if (!row) throw new FuelOrderError("Tedarikci bulunamadi.", 404);
  return row;
}

export function createSupplier(
  stationId: number,
  input: { name: string; email?: string; phone?: string },
  actor: UserRow
): FuelSupplierRow {
  const name = input.name.trim();
  if (name.length < 2) throw new FuelOrderError("Tedarikci adi en az 2 karakter olmalidir.");
  try {
    const result = db
      .prepare("INSERT INTO fuel_suppliers (station_id, name, email, phone, created_by) VALUES (?, ?, ?, ?, ?)")
      .run(stationId, name, input.email?.trim() || null, input.phone?.trim() || null, actor.id);
    return getSupplier(stationId, result.lastInsertRowid as number);
  } catch {
    throw new FuelOrderError("Bu tedarikci zaten kayitli.", 409);
  }
}

export function updateSupplier(
  stationId: number,
  id: number,
  input: { email?: string | null; phone?: string | null; active?: boolean }
): FuelSupplierRow {
  getSupplier(stationId, id);
  const fields: string[] = [];
  const values: unknown[] = [];
  if ("email" in input) { fields.push("email = ?"); values.push(input.email?.trim() || null); }
  if ("phone" in input) { fields.push("phone = ?"); values.push(input.phone?.trim() || null); }
  if ("active" in input) { fields.push("active = ?"); values.push(input.active ? 1 : 0); }
  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE fuel_suppliers SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }
  return getSupplier(stationId, id);
}

// --- Siparis onerisi --------------------------------------------------------

export interface OrderSuggestion {
  fuelType: FuelType;
  currentLiters: number;
  capacityLiters: number;
  lowStockThresholdLiters: number;
  /** Son 14 gunun gunluk ortalama satisi (litre). Satis yoksa 0. */
  dailyAverageLiters: number;
  /** Mevcut stok bu hizla kac gun yeter? Tuketim yoksa null (tahmin yapilamaz). */
  daysOfCover: number | null;
  /** Tanki dolduracak miktar. Zaten doluysa 0. */
  suggestedLiters: number;
  /** Esigin altina dusmus ya da 3 gunden az kalmis mi? */
  urgent: boolean;
  /** Bu yakit icin halihazirda yolda olan siparis var mi? */
  openOrderLiters: number;
}

const COVER_WINDOW_DAYS = 14;

/**
 * "Kac gun yeter" sorusunun cevabi, siparis kararinin en onemli girdisidir - kalan
 * litre tek basina bir sey soylemez: 3.000 litre, gunde 500 litre satan istasyonda bir
 * hafta, gunde 3.000 litre satanda yarim gundur.
 *
 * Pencere 14 gun: daha kisasi tek bir yogun gunun etkisiyle savrulur, daha uzunu
 * mevsimsel degisimi geç yakalar.
 */
function dailyAverage(stationId: number, fuelType: FuelType, now: number): number {
  const since = new Date(now - COVER_WINDOW_DAYS * 86_400_000).toISOString();
  const row = db
    .prepare<[number, string, string], { total: number | null }>(
      `SELECT COALESCE(SUM(-liters), 0) AS total
         FROM fuel_stock_movements
        WHERE station_id = ? AND fuel_type = ? AND type = 'sale' AND created_at >= ?`
    )
    .get(stationId, fuelType, since);
  return round2((row?.total ?? 0) / COVER_WINDOW_DAYS);
}

/** Yolda olan (verilmis ama henuz teslim alinmamis) siparis miktari. */
function openOrderLiters(stationId: number, fuelType: FuelType): number {
  const row = db
    .prepare<[number, string], { total: number | null }>(
      `SELECT COALESCE(SUM(ordered_liters), 0) AS total
         FROM fuel_orders
        WHERE station_id = ? AND fuel_type = ? AND status IN ('draft','sent')`
    )
    .get(stationId, fuelType);
  return round2(row?.total ?? 0);
}

export function suggestions(stationId: number, now = Date.now()): OrderSuggestion[] {
  const tanks = listTanks(stationId);
  return tanks
    .filter((t) => FUEL_TYPES.includes(t.fuel_type as FuelType))
    .map((t) => {
      const fuelType = t.fuel_type as FuelType;
      const dailyAverageLiters = dailyAverage(stationId, fuelType, now);
      const daysOfCover = dailyAverageLiters > 0 ? Math.round((t.current_liters / dailyAverageLiters) * 10) / 10 : null;
      const open = openOrderLiters(stationId, fuelType);
      // Oneri tanki DOLDURACAK miktardir, eksigi kapatan degil: tanker zaten yola
      // ciktiginda yarim getirmesinin bir maliyet avantaji yok. Yolda olan siparis
      // dusulur, aksi halde ayni eksik icin ikinci kez siparis onerilirdi.
      const suggestedLiters = Math.max(0, round2(t.capacity_liters - t.current_liters - open));
      return {
        fuelType,
        currentLiters: round2(t.current_liters),
        capacityLiters: round2(t.capacity_liters),
        lowStockThresholdLiters: round2(t.low_stock_threshold_liters),
        dailyAverageLiters,
        daysOfCover,
        suggestedLiters,
        urgent: t.current_liters <= t.low_stock_threshold_liters || (daysOfCover !== null && daysOfCover < 3),
        openOrderLiters: open,
      };
    });
}

// --- Siparisler -------------------------------------------------------------

export function listOrders(stationId: number, limit = 50): FuelOrderRow[] {
  return db
    .prepare<[number, number], FuelOrderRow>("SELECT * FROM fuel_orders WHERE station_id = ? ORDER BY id DESC LIMIT ?")
    .all(stationId, limit);
}

export type FuelOrderStatus = "draft" | "sent" | "received" | "cancelled";

export interface OrderListFilters {
  /** Birden fazla durum verilebilir (ör. ["received", "cancelled"]) - "gecmis" gorunumu ikisini birden ister. */
  status?: FuelOrderStatus[];
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedOrders {
  orders: FuelOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Gercek sayfalama (OFFSET'li) + durum/tarih filtresi. Ekrandaki "Acik Siparisler"
 * ve "Gecmis" ayrimi hala frontend'de status'e gore yapilir - bu fonksiyon yalnizca
 * kullanicinin sectigi filtreyle sinirli sayfayi doner.
 */
export function listOrdersPaged(stationId: number, filters: OrderListFilters): PagedOrders {
  const clauses = ["station_id = ?"];
  const params: (string | number)[] = [stationId];
  if (filters.status && filters.status.length > 0) {
    clauses.push(`status IN (${filters.status.map(() => "?").join(",")})`);
    params.push(...filters.status);
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

  const total = (
    db.prepare<(string | number)[], { count: number }>(`SELECT COUNT(*) AS count FROM fuel_orders ${where}`).get(...params) ?? {
      count: 0,
    }
  ).count;

  const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 200);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const orders = db
    .prepare<(string | number)[], FuelOrderRow>(`SELECT * FROM fuel_orders ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);

  return { orders, total, page, pageSize };
}

export function getOrder(stationId: number, id: number): FuelOrderRow {
  const row = db.prepare<[number, number], FuelOrderRow>("SELECT * FROM fuel_orders WHERE id = ? AND station_id = ?").get(id, stationId);
  if (!row) throw new FuelOrderError("Siparis bulunamadi.", 404);
  return row;
}

export interface CreateOrderInput {
  fuelType: FuelType;
  supplierId: number;
  liters: number;
  unitCost?: number;
  expectedAt?: string;
  note?: string;
}

export function createOrder(stationId: number, input: CreateOrderInput, actor: UserRow): FuelOrderRow {
  if (!(input.liters > 0)) throw new FuelOrderError("Siparis miktari sifirdan buyuk olmalidir.");
  const supplier = getSupplier(stationId, input.supplierId);
  if (!supplier.active) throw new FuelOrderError("Tedarikci pasif durumda.", 409);

  const result = db
    .prepare(
      `INSERT INTO fuel_orders (station_id, fuel_type, supplier_id, supplier_name, ordered_liters, unit_cost, expected_at, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      stationId,
      input.fuelType,
      supplier.id,
      supplier.name,
      input.liters,
      input.unitCost ?? null,
      input.expectedAt ?? null,
      input.note?.trim() || null,
      actor.id
    );
  return getOrder(stationId, result.lastInsertRowid as number);
}

function assertStatus(order: FuelOrderRow, expected: FuelOrderRow["status"][]): void {
  if (!expected.includes(order.status)) {
    throw new FuelOrderError(`Bu siparis '${order.status}' durumunda; bu islem yapilamaz.`, 409);
  }
}

/**
 * Siparisi tedarikciye gonderir.
 *
 * E-posta gonderimi durumu DEGISTIRMEZ ama basarisizsa siparis yine de 'sent' olur ve
 * personel bunu panelde gorur: tedarikcinin e-postasi kayitli degilse ya da SMTP
 * yapilandirilmamissa siparis telefonla verilmis olabilir - sistemin gorevi kaydi
 * tutmak, tek gonderim kanali olmak degil.
 */
export function sendOrder(stationId: number, id: number, actor: UserRow): FuelOrderRow {
  const order = getOrder(stationId, id);
  assertStatus(order, ["draft"]);

  db.prepare("UPDATE fuel_orders SET status = 'sent', sent_at = ? WHERE id = ?").run(new Date().toISOString(), id);

  const supplier = order.supplier_id === null ? null : db.prepare<[number], FuelSupplierRow>("SELECT * FROM fuel_suppliers WHERE id = ?").get(order.supplier_id);
  if (supplier?.email) {
    const label = FUEL_LABELS[order.fuel_type] ?? order.fuel_type;
    const body =
      `Siparis No: ${order.id}\n` +
      `Urun: ${label}\n` +
      `Miktar: ${order.ordered_liters.toFixed(2)} L\n` +
      (order.unit_cost !== null ? `Anlasilan birim fiyat: ${order.unit_cost.toFixed(4)} TL/L\n` : "") +
      (order.expected_at ? `Beklenen teslim: ${order.expected_at.slice(0, 10)}\n` : "") +
      (order.note ? `Not: ${order.note}\n` : "");
    sendEmail(supplier.email, `[Yakit Siparisi #${order.id}] ${label} ${order.ordered_liters.toFixed(0)} L`, body).catch((err) =>
      logger.error({ err, orderId: order.id }, "Yakit siparisi e-postasi gonderilemedi.")
    );
  } else {
    logger.warn({ orderId: order.id, actorId: actor.id }, "Tedarikcinin e-postasi kayitli degil; siparis kaydedildi ama e-posta gonderilmedi.");
  }

  return getOrder(stationId, id);
}

export function cancelOrder(stationId: number, id: number): FuelOrderRow {
  const order = getOrder(stationId, id);
  // Teslim alinmis siparis iptal edilemez: yakit tanka girdi, kaydi silmek stogu
  // gercekle celiskiye dusururdu.
  assertStatus(order, ["draft", "sent"]);
  db.prepare("UPDATE fuel_orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return getOrder(stationId, id);
}

export interface ReceiveOrderInput {
  liters: number;
  deliveryRef?: string;
  note?: string;
  unitCost?: number;
  force?: boolean;
  measuredBefore?: number;
  measuredAfter?: number;
}

/**
 * Siparisi teslim alir: MEVCUT teslimat yolunu (addStock) oldugu gibi kullanir.
 *
 * Boylece teslimat kabul farki, irsaliye tekrari kontrolu, maliyet ortalamasi ve
 * dusuk stok alarminin cozulmesi - hepsi degismeden calisir. Bu fonksiyonun ekledigi
 * tek sey, olusan hareketi siparisle eslestirmesidir.
 *
 * Bir siparis yalnizca BIR kez teslim alinabilir; aksi halde ayni tanker iki kez
 * stoga girerdi.
 */
export function receiveOrder(
  stationId: number,
  id: number,
  input: ReceiveOrderInput,
  actor: UserRow
): { order: FuelOrderRow; overflow: number; variance: ReturnType<typeof addStock>["variance"] } {
  const order = getOrder(stationId, id);
  assertStatus(order, ["draft", "sent"]);

  let result: ReturnType<typeof addStock>;
  try {
    result = addStock(
      stationId,
      order.fuel_type as FuelType,
      input.liters,
      {
        supplier: order.supplier_name,
        deliveryRef: input.deliveryRef || null,
        note: input.note,
        unitCost: input.unitCost ?? order.unit_cost ?? null,
        force: input.force,
        measuredBefore: input.measuredBefore,
        measuredAfter: input.measuredAfter,
      },
      actor
    );
  } catch (err) {
    // FuelStockError (ör. irsaliye tekrari) oldugu gibi yukari cikar; siparis
    // durumu degismez, personel duzeltip yeniden dener.
    if (err instanceof FuelStockError) throw err;
    throw err;
  }

  const movementId = db
    .prepare<[number, string], { id: number }>(
      "SELECT id FROM fuel_stock_movements WHERE station_id = ? AND fuel_type = ? AND type = 'delivery' ORDER BY id DESC LIMIT 1"
    )
    .get(stationId, order.fuel_type)!.id;

  db.prepare(
    "UPDATE fuel_orders SET status = 'received', received_at = ?, received_liters = ?, delivery_movement_id = ? WHERE id = ?"
  ).run(new Date().toISOString(), result.variance.acceptedLiters, movementId, id);

  return { order: getOrder(stationId, id), overflow: result.overflow, variance: result.variance };
}

export function serializeSupplier(s: FuelSupplierRow) {
  return { id: s.id, name: s.name, email: s.email, phone: s.phone, active: !!s.active };
}

export function serializeOrder(o: FuelOrderRow) {
  return {
    id: o.id,
    fuelType: o.fuel_type,
    supplierId: o.supplier_id,
    supplierName: o.supplier_name,
    orderedLiters: o.ordered_liters,
    receivedLiters: o.received_liters,
    unitCost: o.unit_cost,
    expectedAt: o.expected_at,
    status: o.status,
    note: o.note,
    deliveryMovementId: o.delivery_movement_id,
    sentAt: o.sent_at,
    receivedAt: o.received_at,
    createdAt: o.created_at,
  };
}
