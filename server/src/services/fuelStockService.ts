import { db } from "../db/index.js";
import type { FuelStockMovementRow, FuelTankRow, FuelType, UserRow } from "../db/types.js";
import { broadcast } from "../ws/hub.js";
import { createAlarm, broadcastAlarms } from "./alarmService.js";

export class FuelStockError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** Ayni istasyon+yakit tipinde daha once ayni irsaliye/fis no ile teslimat kaydedilmisse firlatilir. */
export class DuplicateDeliveryRefError extends FuelStockError {
  constructor(
    public movementId: number,
    public existingCreatedAt: string
  ) {
    super("Bu irsaliye/fis numarasiyla bu yakit tipi icin daha once bir teslimat kaydedilmis.", 409);
  }
}

export const FUEL_TYPES: FuelType[] = ["benzin", "motorin", "lpg"];

export type TankStatus = "ok" | "low" | "critical";

export function tankStatus(t: FuelTankRow): TankStatus {
  if (t.current_liters <= t.low_stock_threshold_liters) return "critical";
  if (t.current_liters <= t.low_stock_threshold_liters * 1.5) return "low";
  return "ok";
}

export function serializeTank(t: FuelTankRow) {
  return {
    fuelType: t.fuel_type,
    capacityLiters: Math.round(t.capacity_liters * 100) / 100,
    currentLiters: Math.round(t.current_liters * 100) / 100,
    lowStockThresholdLiters: Math.round(t.low_stock_threshold_liters * 100) / 100,
    averageCostPerLiter: Math.round(t.average_cost_per_liter * 100) / 100,
    percentFull: t.capacity_liters > 0 ? Math.round((t.current_liters / t.capacity_liters) * 1000) / 10 : 0,
    status: tankStatus(t),
    updatedAt: t.updated_at,
  };
}

export function serializeMovement(m: FuelStockMovementRow, username: string | null) {
  return {
    id: m.id,
    fuelType: m.fuel_type,
    type: m.type,
    liters: Math.round(m.liters * 100) / 100,
    balanceAfter: Math.round(m.balance_after * 100) / 100,
    supplier: m.supplier,
    deliveryRef: m.delivery_ref,
    note: m.note,
    unitCost: m.unit_cost,
    transactionId: m.transaction_id,
    username,
    createdAt: m.created_at,
  };
}

function getTank(stationId: number, fuelType: FuelType): FuelTankRow {
  const row = db
    .prepare<[number, string], FuelTankRow>("SELECT * FROM fuel_tanks WHERE station_id = ? AND fuel_type = ?")
    .get(stationId, fuelType);
  if (row) return row;
  // Bu istasyon icin tank kaydi henuz olusmamissa (ör. sema henuz uygulanmadan
  // once olusturulmus eski bir istasyon) varsayilan degerlerle olusturulur.
  db.prepare(
    "INSERT INTO fuel_tanks (station_id, fuel_type) VALUES (?, ?) ON CONFLICT(station_id, fuel_type) DO NOTHING"
  ).run(stationId, fuelType);
  return db.prepare<[number, string], FuelTankRow>("SELECT * FROM fuel_tanks WHERE station_id = ? AND fuel_type = ?").get(stationId, fuelType)!;
}

export function listTanks(stationId: number): FuelTankRow[] {
  return FUEL_TYPES.map((ft) => getTank(stationId, ft));
}

export function broadcastTanks(stationId: number): void {
  broadcast(`fuel-stock:${stationId}`, listTanks(stationId).map(serializeTank));
}

function insertMovement(params: {
  stationId: number;
  fuelType: FuelType;
  type: FuelStockMovementRow["type"];
  liters: number;
  balanceAfter: number;
  supplier?: string | null;
  deliveryRef?: string | null;
  note?: string | null;
  unitCost?: number | null;
  transactionId?: number | null;
  userId?: number | null;
}): void {
  db.prepare(
    `INSERT INTO fuel_stock_movements
      (station_id, fuel_type, type, liters, balance_after, supplier, delivery_ref, note, unit_cost, transaction_id, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.stationId,
    params.fuelType,
    params.type,
    params.liters,
    params.balanceAfter,
    params.supplier ?? null,
    params.deliveryRef ?? null,
    params.note ?? null,
    params.unitCost ?? null,
    params.transactionId ?? null,
    params.userId ?? null
  );
}

/** excludeMovementId: bir hareketin kendi irsaliye no'sunu duzenlerken kendisiyle carpismasin diye. */
function findDuplicateDeliveryRef(
  stationId: number,
  fuelType: FuelType,
  deliveryRef: string,
  excludeMovementId = -1
): { id: number; createdAt: string } | undefined {
  const row = db
    .prepare<[number, string, string, number], { id: number; created_at: string }>(
      `SELECT id, created_at FROM fuel_stock_movements
       WHERE station_id = ? AND fuel_type = ? AND type = 'delivery' AND lower(trim(delivery_ref)) = lower(trim(?)) AND id != ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(stationId, fuelType, deliveryRef, excludeMovementId);
  return row ? { id: row.id, createdAt: row.created_at } : undefined;
}

/**
 * Depoya yakit teslimati (stok ekleme) kaydeder. Tank kapasitesini asan kisim eklenmez ("tasma").
 * Irsaliye/fis no opsiyoneldir - girilmemisse (veya sonradan Stok Hareketleri tablosundaki
 * "Duzenle" ile eklenecekse) mukerrer kontrolu atlanir. Girilmisse ve ayni istasyon+yakit
 * tipinde daha once ayni numarayla teslimat kaydedilmisse, `force` gecilmedigi surece
 * DuplicateDeliveryRefError firlatilir - cagiran taraf (route) bunu kullaniciya onaylatip
 * force:true ile tekrar cagirabilir. Not: ayni irsaliyenin FARKLI yakit tipleri icin
 * tekrarlanmasi normaldir (tek tankerde birden fazla urun ayni irsaliye ile gelebilir), bu
 * yuzden kontrol yakit tipine ozeldir.
 */
export function addStock(
  stationId: number,
  fuelType: FuelType,
  liters: number,
  meta: { supplier: string; deliveryRef?: string | null; note?: string; unitCost?: number | null; force?: boolean },
  actor: UserRow
): { tank: FuelTankRow; overflow: number } {
  if (liters <= 0) throw new FuelStockError("Eklenecek miktar sifirdan buyuk olmalidir.", 400);

  if (meta.deliveryRef && !meta.force) {
    const duplicate = findDuplicateDeliveryRef(stationId, fuelType, meta.deliveryRef);
    if (duplicate) throw new DuplicateDeliveryRefError(duplicate.id, duplicate.createdAt);
  }

  const tank = getTank(stationId, fuelType);
  const capacityLeft = Math.max(0, tank.capacity_liters - tank.current_liters);
  const actualAdded = Math.min(liters, capacityLeft);
  const overflow = Math.round((liters - actualAdded) * 100) / 100;
  const newLevel = Math.round((tank.current_liters + actualAdded) * 100) / 100;

  // Birim maliyet girildiyse, tankin agirlikli ortalama maliyetini guncelle. Maliyet
  // girilmemis teslimatlar ortalamayi ETKILEMEZ (bilinmeyen maliyet, mevcut ortalamayla
  // "sulandirilmaz") - bu yuzden kar raporu her zaman yalnizca maliyeti girilen
  // teslimatlara dayanan bir YAKLASIK degerdir.
  let newAvgCost = tank.average_cost_per_liter;
  if (meta.unitCost && meta.unitCost > 0 && actualAdded > 0) {
    const totalCostBefore = tank.average_cost_per_liter * tank.current_liters;
    const totalCostAfter = totalCostBefore + meta.unitCost * actualAdded;
    newAvgCost = newLevel > 0 ? Math.round((totalCostAfter / newLevel) * 10000) / 10000 : meta.unitCost;
  }

  db.prepare(
    "UPDATE fuel_tanks SET current_liters = ?, average_cost_per_liter = ?, updated_at = ?, updated_by = ? WHERE station_id = ? AND fuel_type = ?"
  ).run(newLevel, newAvgCost, new Date().toISOString(), actor.id, stationId, fuelType);

  const note = overflow > 0 ? `${meta.note ?? ""} (Kapasite asimi: ${overflow} L eklenemedi)`.trim() : (meta.note ?? null);
  insertMovement({
    stationId,
    fuelType,
    type: "delivery",
    liters: actualAdded,
    balanceAfter: newLevel,
    supplier: meta.supplier,
    deliveryRef: meta.deliveryRef,
    note,
    unitCost: meta.unitCost || null,
    userId: actor.id,
  });

  resolveLowStockAlarmIfRecovered(stationId, fuelType, newLevel, tank.low_stock_threshold_liters, actor);

  broadcastTanks(stationId);
  return { tank: getTank(stationId, fuelType), overflow };
}

export function getAvailableLiters(stationId: number, fuelType: FuelType): number {
  return getTank(stationId, fuelType).current_liters;
}

export interface DeductResult {
  actual: number;
  /** Istenen miktarin tamami karsilanamadi (tank o an bunun altindaydi) - yuvarlama degil, gercek kisitlama. */
  limited: boolean;
}

/**
 * Dolum sirasinda (her tick'te) gercek zamanli olarak tanktan dusum yapar; istenen
 * miktar tankta kalandan fazlaysa yalnizca mevcut olan kadari dusulur. Boylece ayni
 * tanktan besleniyor olabilecek birden fazla pompa, depo bosaldiginda dogru sekilde
 * birbirini sinirlar (tek seferlik toplu dusum yerine). `limited`, yuvarlamadan
 * ETKILENMEYECEK sekilde asil (yuvarlanmamis) miktarlar karsilastirilarak hesaplanir -
 * aksi halde normal (stok yeterliyken) durumlarda bile kucuk yuvarlama farklari
 * "depo tukendi" sanilmasina yol acabilirdi. Hareket kaydi burada TUTULMAZ; islem
 * tamamlaninca recordSaleMovement ile tek satirlik ozet kaydedilir.
 */
export function deductAvailable(stationId: number, fuelType: FuelType, desiredLiters: number): DeductResult {
  if (desiredLiters <= 0) return { actual: 0, limited: false };
  const tank = getTank(stationId, fuelType);
  const limited = tank.current_liters < desiredLiters;
  const actualRaw = limited ? tank.current_liters : desiredLiters;
  if (actualRaw <= 0) return { actual: 0, limited: true };

  const newLevel = Math.max(0, Math.round((tank.current_liters - actualRaw) * 100) / 100);
  db.prepare("UPDATE fuel_tanks SET current_liters = ?, updated_at = ? WHERE station_id = ? AND fuel_type = ?").run(
    newLevel,
    new Date().toISOString(),
    stationId,
    fuelType
  );

  if (newLevel <= tank.low_stock_threshold_liters) {
    raiseLowStockAlarmIfNeeded(stationId, fuelType, newLevel);
  }

  broadcastTanks(stationId);
  // Tank siniri asilmadiysa TAM (yuvarlanmamis) miktar dondurulur: aksi halde
  // dolumun son anindaki kucuk artislar (<0.005 L) 2 ondalige yuvarlanip sifira
  // duserdi ve "dispensed_liters" hicbir zaman hedefe ulasamayip islem sonsuza
  // kadar "dispensing" durumunda takili kalirdi. Tank gercekten tukendiyse
  // (limited=true) actual, tank seviyesindeki gercek (yuvarlanmis) degisimden alinir.
  const actual = limited ? Math.round((tank.current_liters - newLevel) * 100) / 100 : actualRaw;
  return { actual, limited };
}

/** Bir satis tamamlandiginda (veya kismen kesildiginde) tek satirlik ozet hareket kaydi olusturur. Tank seviyesi bu fonksiyonda DEGISTIRILMEZ; dusum zaten deductAvailable ile tick tick yapilmis olur. */
export function recordSaleMovement(stationId: number, fuelType: FuelType, liters: number, transactionId: number): void {
  if (liters <= 0) return;
  const tank = getTank(stationId, fuelType);
  insertMovement({
    stationId,
    fuelType,
    type: "sale",
    liters: -liters,
    balanceAfter: tank.current_liters,
    transactionId,
  });
}

/** Yonetici, fiziksel olcum sonrasi tank seviyesini dogrudan duzeltir (ör. sayac farki). Aciklama zorunludur - denetim icin her duzeltmenin gercek bir gerekcesi kayit altina alinir. */
export function adjustStock(stationId: number, fuelType: FuelType, newLiters: number, note: string, actor: UserRow): FuelTankRow {
  if (newLiters < 0) throw new FuelStockError("Stok miktari negatif olamaz.", 400);
  const tank = getTank(stationId, fuelType);
  const clamped = Math.min(newLiters, tank.capacity_liters);
  const delta = Math.round((clamped - tank.current_liters) * 100) / 100;

  db.prepare(
    "UPDATE fuel_tanks SET current_liters = ?, updated_at = ?, updated_by = ? WHERE station_id = ? AND fuel_type = ?"
  ).run(clamped, new Date().toISOString(), actor.id, stationId, fuelType);

  insertMovement({
    stationId,
    fuelType,
    type: "adjustment",
    liters: delta,
    balanceAfter: clamped,
    note,
    userId: actor.id,
  });

  if (clamped <= tank.low_stock_threshold_liters) {
    raiseLowStockAlarmIfNeeded(stationId, fuelType, clamped);
  } else {
    resolveLowStockAlarmIfRecovered(stationId, fuelType, clamped, tank.low_stock_threshold_liters, actor);
  }

  broadcastTanks(stationId);
  return getTank(stationId, fuelType);
}

export function updateTankSettings(
  stationId: number,
  fuelType: FuelType,
  input: { capacityLiters?: number; lowStockThresholdLiters?: number },
  actor: UserRow
): FuelTankRow {
  const tank = getTank(stationId, fuelType);
  const capacity = input.capacityLiters ?? tank.capacity_liters;
  const threshold = input.lowStockThresholdLiters ?? tank.low_stock_threshold_liters;
  if (capacity <= 0) throw new FuelStockError("Tank kapasitesi sifirdan buyuk olmalidir.", 400);
  if (threshold < 0 || threshold > capacity) throw new FuelStockError("Dusuk stok esigi gecersiz.", 400);

  db.prepare(
    "UPDATE fuel_tanks SET capacity_liters = ?, low_stock_threshold_liters = ?, updated_at = ?, updated_by = ? WHERE station_id = ? AND fuel_type = ?"
  ).run(capacity, threshold, new Date().toISOString(), actor.id, stationId, fuelType);

  broadcastTanks(stationId);
  return getTank(stationId, fuelType);
}

/** Istasyon kapsamli tekil hareket sorgusu (IDOR korumali - baska istasyonun hareketi 404 doner). */
export function getMovementById(id: number, stationId: number): FuelStockMovementRow {
  const row = db.prepare<[number], FuelStockMovementRow>("SELECT * FROM fuel_stock_movements WHERE id = ?").get(id);
  if (!row || row.station_id !== stationId) throw new FuelStockError("Hareket bulunamadi.", 404);
  return row;
}

/**
 * Bir teslimat hareketinin irsaliye/fis no'sunu sonradan ekler/duzenler/temizler (deliveryRef
 * null gecilirse temizlenir). Yalnizca "delivery" tipi hareketlerde anlamli oldugundan diger
 * tiplerde reddedilir. Ayni mukerrer-kontrolu addStock ile paylasilir (force ile atlanabilir).
 */
export function setDeliveryRef(id: number, stationId: number, deliveryRef: string | null, force: boolean): FuelStockMovementRow {
  const movement = getMovementById(id, stationId);
  if (movement.type !== "delivery") throw new FuelStockError("Irsaliye/fis no yalnizca teslimat hareketlerinde duzenlenebilir.", 400);

  if (deliveryRef && !force) {
    const duplicate = findDuplicateDeliveryRef(stationId, movement.fuel_type, deliveryRef, movement.id);
    if (duplicate) throw new DuplicateDeliveryRefError(duplicate.id, duplicate.createdAt);
  }

  db.prepare("UPDATE fuel_stock_movements SET delivery_ref = ? WHERE id = ?").run(deliveryRef, id);
  return getMovementById(id, stationId);
}

export function listMovements(stationId: number, filters: { fuelType?: FuelType; limit?: number }): (FuelStockMovementRow & { username: string | null })[] {
  const clauses = ["m.station_id = ?"];
  const params: unknown[] = [stationId];
  if (filters.fuelType) {
    clauses.push("m.fuel_type = ?");
    params.push(filters.fuelType);
  }
  const limit = Math.min(filters.limit ?? 200, 1000);
  return db
    .prepare<unknown[], FuelStockMovementRow & { username: string | null }>(
      `SELECT m.*, u.username as username
       FROM fuel_stock_movements m LEFT JOIN users u ON u.id = m.user_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(...params, limit);
}

export interface SupplierSummaryRow {
  supplier: string;
  fuelType: FuelType;
  deliveryCount: number;
  totalLiters: number;
  avgUnitCost: number | null;
  lastDeliveryAt: string;
}

/** Tedarikci + yakit tipi bazinda teslimat ozeti (Yakit Stoku sayfasindaki "Tedarikci Ozeti" tablosu icin). */
export function getSupplierSummary(stationId: number): SupplierSummaryRow[] {
  const rows = db
    .prepare<[number], { supplier: string; fuel_type: FuelType; deliveryCount: number; totalLiters: number; costedLiters: number; totalCost: number; lastDeliveryAt: string }>(
      `SELECT supplier, fuel_type,
              COUNT(*) as deliveryCount,
              COALESCE(SUM(liters), 0) as totalLiters,
              COALESCE(SUM(CASE WHEN unit_cost IS NOT NULL THEN liters ELSE 0 END), 0) as costedLiters,
              COALESCE(SUM(CASE WHEN unit_cost IS NOT NULL THEN liters * unit_cost ELSE 0 END), 0) as totalCost,
              MAX(created_at) as lastDeliveryAt
       FROM fuel_stock_movements
       WHERE station_id = ? AND type = 'delivery' AND supplier IS NOT NULL AND trim(supplier) != ''
       GROUP BY supplier, fuel_type
       ORDER BY totalLiters DESC`
    )
    .all(stationId);

  return rows.map((r) => ({
    supplier: r.supplier,
    fuelType: r.fuel_type,
    deliveryCount: r.deliveryCount,
    totalLiters: Math.round(r.totalLiters * 100) / 100,
    avgUnitCost: r.costedLiters > 0 ? Math.round((r.totalCost / r.costedLiters) * 10000) / 10000 : null,
    lastDeliveryAt: r.lastDeliveryAt,
  }));
}

const FUEL_LABELS: Record<FuelType, string> = { benzin: "Benzin", motorin: "Motorin", lpg: "LPG" };

function lowStockAlarmType(fuelType: FuelType): string {
  return `low_stock_${fuelType}`;
}

function raiseLowStockAlarmIfNeeded(stationId: number, fuelType: FuelType, level: number): void {
  const message =
    level <= 0
      ? `${FUEL_LABELS[fuelType]} tanki tukendi. Bu yakit tipi icin kiosk'ta yeni satis alinamiyor; acilen ikmal yapin.`
      : `${FUEL_LABELS[fuelType]} tanki dusuk seviyede (${Math.round(level)} L kaldi). Yakit ikmali yapin.`;

  const existing = db
    .prepare<[number, string], { id: number; message: string }>(
      "SELECT id, message FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved' LIMIT 1"
    )
    .get(stationId, lowStockAlarmType(fuelType));

  if (existing) {
    // Zaten aktif bir uyari varsa spam olmasin diye yeni alarm acilmaz, ama tank
    // tamamen tukendiginde ("dusuk" -> "bitti") mesaj bayat kalmasin diye guncellenir.
    if (level <= 0 && existing.message !== message) {
      db.prepare("UPDATE alarms SET message = ? WHERE id = ?").run(message, existing.id);
      broadcastAlarms(stationId);
    }
    return;
  }

  createAlarm({ stationId, type: lowStockAlarmType(fuelType), severity: "critical", message });
}

function resolveLowStockAlarmIfRecovered(stationId: number, fuelType: FuelType, level: number, threshold: number, actor: UserRow): void {
  if (level <= threshold) return;
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE alarms SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE station_id = ? AND type = ? AND status != 'resolved'")
    .run(actor.id, now, stationId, lowStockAlarmType(fuelType));
  if (result.changes > 0) broadcastAlarms(stationId);
}
