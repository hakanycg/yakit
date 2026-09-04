import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import type { FuelOrderRow, FuelSupplierRow, FuelType, StationRow, UserRow } from "../db/types.js";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";
import { safeCompare } from "../utils/safeCompare.js";
import { sendEmail, sendSms } from "./notificationService.js";
import { FUEL_TYPES, FuelStockError, addStock, broadcastTanks, listTanks } from "./fuelStockService.js";

/** Takip linkinin gecerlilik suresi - cogu teslimat cok daha kisa surer, ama beklenmedik
 * bir gecikme (trafik, aksilik) yasandiginda linkin erken sessizce olmesini onlemek icin
 * cömert tutuldu. */
const TRACKING_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

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
  // Tanker canli konum takibi: sofor telefonu girilmisse siparis gonderilirken (bkz.
  // sendOrder) bir takip linki SMS'lenir. Ikisi de opsiyonel - mevcut siparis akisini
  // bozmadan eklenir.
  driverPhone?: string;
  tankerPlate?: string;
}

export function createOrder(stationId: number, input: CreateOrderInput, actor: UserRow): FuelOrderRow {
  if (!(input.liters > 0)) throw new FuelOrderError("Siparis miktari sifirdan buyuk olmalidir.");
  const supplier = getSupplier(stationId, input.supplierId);
  if (!supplier.active) throw new FuelOrderError("Tedarikci pasif durumda.", 409);

  const result = db
    .prepare(
      `INSERT INTO fuel_orders (station_id, fuel_type, supplier_id, supplier_name, ordered_liters, unit_cost, expected_at, note, driver_phone, tanker_plate, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      input.driverPhone?.trim() || null,
      input.tankerPlate?.trim().toUpperCase() || null,
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

  if (order.driver_phone) {
    sendTrackingLink(getOrder(stationId, id));
  }

  return getOrder(stationId, id);
}

/**
 * Sofor telefonu girilmis bir siparis gonderilirken, tanker'in canli konumunu
 * paylasabilecegi girissiz bir link SMS'lenir (bkz. routes/tankerTracking.ts).
 *
 * Token kiosk_access_token ile AYNI desen: randomBytes(24) -> base64url, tahmin
 * edilemez, tek siparise ozel, suresi dolar. PUBLIC_API_BASE_URL yapilandirilmamissa
 * (ör. yerel gelistirme) link olusturulamaz - islemi BOZMAZ, yalnizca loglanir.
 */
function sendTrackingLink(order: FuelOrderRow): void {
  if (!env.PUBLIC_API_BASE_URL) {
    logger.warn({ orderId: order.id }, "PUBLIC_API_BASE_URL tanimlanmamis - tanker takip linki gonderilemedi.");
    return;
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + TRACKING_TOKEN_TTL_MS).toISOString();
  db.prepare("UPDATE fuel_orders SET tracking_token = ?, tracking_token_expires_at = ? WHERE id = ?").run(token, expiresAt, order.id);

  const link = `${env.PUBLIC_API_BASE_URL}/tanker-takip/${order.id}?token=${token}`;
  const label = FUEL_LABELS[order.fuel_type] ?? order.fuel_type;
  const message = `Yakit siparisi #${order.id} (${label}, ${order.ordered_liters.toFixed(0)} L) icin konum paylasim linki: ${link}`;
  sendSms(order.driver_phone!, message).catch((err) => logger.error({ err, orderId: order.id }, "Tanker takip linki SMS'i gonderilemedi."));
}

/**
 * Tanker istasyona gelip fiili bosaltma baslayinca personel bunu isaretler.
 *
 * Asama 1 (simdi): elle isaretlenir - sistemde gercek bir tank seviye probu bagli
 * degil (bkz. tankGaugeDriver.ts, noop). Asama 2 (gercek prob baglaninca): bu,
 * ATG konsollarinin zaten kullandigi deterministik bir esik kuraliyla (seviyenin
 * kesintisiz yukselmesi) otomatik tespit edilebilir - simdilik yer birakiliyor.
 *
 * Durum 'delivering' oldugu surece bu yakit turunun otomatik prob okumasi atlanir
 * (bkz. tankGaugeService.hasActiveDelivery) - aksi halde dolan tank, sahte bir
 * "kayip" sapma alarmi uretirdi (aninda buyuk hacim artisi).
 */
export function startDelivery(stationId: number, id: number, actor: UserRow): FuelOrderRow {
  const order = getOrder(stationId, id);
  assertStatus(order, ["sent"]);

  db.prepare("UPDATE fuel_orders SET status = 'delivering', delivery_started_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  logger.info({ orderId: id, actorId: actor.id }, "Tanker teslimati basladi olarak isaretlendi.");
  broadcastTanks(stationId);

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
  // 'delivering': personel "Teslimat Basladi" demis olabilir ama teslim alma
  // adimini atlamiyor - bosaltma bitince yine burasi kullanilir.
  assertStatus(order, ["draft", "sent", "delivering"]);

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
    deliveryStartedAt: o.delivery_started_at,
    receivedAt: o.received_at,
    createdAt: o.created_at,
    driverPhone: o.driver_phone,
    tankerPlate: o.tanker_plate,
    // Ham token asla panele donmez - yalnizca linkin var olup olmadigini ve son
    // bilinen konumu gorunur kilariz (bkz. routes/tankerTracking.ts).
    hasTrackingLink: !!o.tracking_token,
    lastLat: o.last_lat,
    lastLng: o.last_lng,
    lastLocationAt: o.last_location_at,
  };
}

export interface TrackingInfo {
  orderId: number;
  stationName: string;
  targetLat: number | null;
  targetLng: number | null;
  fuelType: string;
  orderedLiters: number;
  status: FuelOrderRow["status"];
}

/**
 * Token'i (kiosk_access_token ile AYNI desen - bkz. sendTrackingLink) dogrular ve
 * bulunamama/gecersiz/suresi dolmus durumlarinin HEPSINI ayni jenerik hatayla
 * doner - hangisinin gecerli oldugunu disariya sizdirmamak icin (siparis
 * numarasi tahmin edilebilir olsa da token degil).
 */
function getOrderByTrackingToken(orderId: number, token: string): FuelOrderRow {
  const order = db.prepare<[number], FuelOrderRow>("SELECT * FROM fuel_orders WHERE id = ?").get(orderId);
  const expired = !!order?.tracking_token_expires_at && new Date(order.tracking_token_expires_at).getTime() < Date.now();
  if (!order || !order.tracking_token || !safeCompare(order.tracking_token, token) || expired) {
    throw new FuelOrderError("Gecersiz veya suresi dolmus takip linki.", 403);
  }
  return order;
}

export function getTrackingInfo(orderId: number, token: string): TrackingInfo {
  const order = getOrderByTrackingToken(orderId, token);
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(order.station_id)!;
  return {
    orderId: order.id,
    stationName: station.name,
    targetLat: station.latitude,
    targetLng: station.longitude,
    fuelType: order.fuel_type,
    orderedLiters: order.ordered_liters,
    status: order.status,
  };
}

/**
 * Soforun cihazindan periyodik konum guncellemesi. Yalnizca KENDI siparisinin
 * satirini gunceller (token, o siparise ozeldir) - istasyon geneli veri sizintisi
 * yok. Panelde canli gorunmesi icin ayni fuel-stock topic'i tetiklenir (bkz.
 * FuelStock.tsx'in mevcut useTopicSubscription'i - yeniden REST ile ceker).
 */
export function updateTrackerLocation(orderId: number, token: string, lat: number, lng: number): void {
  const order = getOrderByTrackingToken(orderId, token);
  db.prepare("UPDATE fuel_orders SET last_lat = ?, last_lng = ?, last_location_at = ? WHERE id = ?").run(lat, lng, new Date().toISOString(), orderId);
  broadcastTanks(order.station_id);
}
