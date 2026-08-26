import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  DuplicateDeliveryRefError,
  FuelStockError,
  addStock,
  adjustStock,
  getMovementById,
  getSupplierSummary,
  listMovements,
  listTanks,
  serializeMovement,
  serializeTank,
  setDeliveryRef,
  updateTankSettings,
} from "../services/fuelStockService.js";
import {
  getVarianceSettings,
  getVarianceSummary,
  listReadings,
  recordReading,
  serializeReading,
  updateVarianceSettings,
} from "../services/fuelVarianceService.js";
import {
  DeliveryVarianceError,
  getDeliveryVarianceSettings,
  getSupplierDeliveryVariance,
  updateDeliveryVarianceSettings,
} from "../services/deliveryVarianceService.js";
import {
  FuelOrderError,
  cancelOrder,
  createOrder,
  createSupplier,
  listOrders,
  listSuppliers,
  receiveOrder,
  sendOrder,
  serializeOrder,
  serializeSupplier,
  suggestions,
  updateSupplier,
} from "../services/fuelOrderService.js";
import { getWaterThresholdMm } from "../services/tankWaterService.js";
import { createWaybill, WaybillError } from "../services/waybillService.js";
import { getWaybillForMovement, recordWaybillFailure, recordWaybillSuccess, serializeWaybill } from "../services/waybillRecordService.js";

const router = Router();
// Yakit stogu yalnizca istasyon yoneticisine (admin) ve platform yoneticisine (super_admin,
// her zaman gectigi icin) acik; operator/viewer bu sayfayi goremez/duzenleyemez.
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected);

const fuelTypeEnum = z.enum(["benzin", "motorin", "lpg"]);

router.get("/", (req, res) => {
  res.json({ tanks: listTanks(req.stationId!).map(serializeTank) });
});

const movementsQuerySchema = z.object({
  fuelType: fuelTypeEnum.optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

router.get("/movements", validateQuery(movementsQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof movementsQuerySchema> }).validatedQuery;
  const rows = listMovements(req.stationId!, q);
  res.json({ movements: rows.map((m) => serializeMovement(m, m.username)) });
});

router.get("/movements/export.csv", validateQuery(movementsQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof movementsQuerySchema> }).validatedQuery;
  const rows = listMovements(req.stationId!, { ...q, limit: q.limit ?? 1000 });

  const header = ["id", "yakit_tipi", "tip", "litre", "bakiye", "tedarikci", "irsaliye_no", "not", "kullanici", "tarih"];
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const typeLabel: Record<string, string> = { delivery: "Teslimat", sale: "Satis", adjustment: "Duzeltme" };
  const lines = [header.join(",")];
  for (const m of rows) {
    lines.push(
      [m.id, m.fuel_type, typeLabel[m.type] ?? m.type, m.liters, m.balance_after, m.supplier, m.delivery_ref, m.note, m.username, m.created_at]
        .map(escape)
        .join(",")
    );
  }

  recordAudit({ user: req.user!, action: "fuel_stock_movements_exported", details: { count: rows.length }, ip: req.ip, stationId: req.stationId });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="yakit-stok-hareketleri-${Date.now()}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

router.get("/suppliers/summary", (req, res) => {
  res.json({ suppliers: getSupplierSummary(req.stationId!) });
});

// --- Yakit sapma (fiziksel tank olcumu) ---------------------------------------

const readingsQuerySchema = z.object({
  fuelType: fuelTypeEnum.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

router.get("/readings", validateQuery(readingsQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof readingsQuerySchema> }).validatedQuery;
  const rows = listReadings(req.stationId!, q);
  res.json({
    readings: rows.map((r) => serializeReading(r, r.username)),
    summary: getVarianceSummary(req.stationId!),
    settings: getVarianceSettings(req.stationId!),
    waterThresholdMm: getWaterThresholdMm(req.stationId!),
  });
});

router.get("/readings/export.csv", validateQuery(readingsQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof readingsQuerySchema> }).validatedQuery;
  const rows = listReadings(req.stationId!, { ...q, limit: q.limit ?? 500 });

  const header = [
    "id",
    "yakit_tipi",
    "olcum_litre",
    "kayit_litre",
    "sapma_litre",
    "sicaklik_c",
    "su_mm",
    "sicaklik_duzeltmesi_litre",
    "duzeltilmis_sapma_litre",
    "hareket_hacmi_litre",
    "sapma_yuzde",
    "alarm_id",
    "not",
    "kullanici",
    "olcum_tarihi",
  ];
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.fuel_type,
        r.measured_liters,
        r.book_liters,
        r.variance_liters,
        r.temperature_celsius,
        r.water_level_mm,
        r.temperature_correction_liters,
        r.adjusted_variance_liters,
        r.throughput_liters,
        r.variance_pct,
        r.alarm_id,
        r.note,
        r.username,
        r.measured_at,
      ]
        .map(escape)
        .join(",")
    );
  }

  recordAudit({ user: req.user!, action: "fuel_tank_readings_exported", details: { count: rows.length }, ip: req.ip, stationId: req.stationId });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="yakit-sapma-${Date.now()}.csv"`);
  res.send("\ufeff" + lines.join("\n"));
});

const varianceSettingsSchema = z.object({
  thresholdPct: z.number().min(0).max(100).optional(),
  minLiters: z.number().min(0).max(10000).optional(),
});

router.patch("/readings/settings", csrfProtection, validateBody(varianceSettingsSchema), (req, res) => {
  try {
    const settings = updateVarianceSettings(req.stationId!, req.body as z.infer<typeof varianceSettingsSchema>, req.user!);
    recordAudit({
      user: req.user!,
      action: "fuel_variance_settings_updated",
      details: settings,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ settings });
  } catch (err) {
    if (err instanceof FuelStockError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const readingSchema = z.object({
  measuredLiters: z.number().min(0).max(1000000),
  measuredAt: z.string().datetime().optional(),
  note: z.string().max(300).optional(),
  /** Su bulucu macunla olculen tank dibi su seviyesi (mm); olculmediyse gonderilmez. */
  waterLevelMm: z.number().min(0).max(1000).optional(),
  /** Sicaklik olculduyse; sapma hesabinda genlesmeyi ayiklamak icin (bkz. fuelVarianceService). */
  temperatureCelsius: z.number().min(-40).max(70).optional(),
});

router.post("/:fuelType/reading", csrfProtection, validateBody(readingSchema), (req, res) => {
  const fuelType = fuelTypeEnum.safeParse(req.params.fuelType);
  if (!fuelType.success) return void res.status(400).json({ error: "Gecersiz yakit tipi." });

  try {
    const { measuredLiters, measuredAt, note, waterLevelMm, temperatureCelsius } = req.body as z.infer<
      typeof readingSchema
    >;
    const { reading, alarmRaised, waterAlarmRaised } = recordReading({
      stationId: req.stationId!,
      fuelType: fuelType.data,
      measuredLiters,
      measuredAt,
      note,
      waterLevelMm,
      temperatureCelsius,
      actor: req.user!,
    });

    recordAudit({
      user: req.user!,
      action: "fuel_tank_reading_recorded",
      entityType: "fuel_tank_reading",
      entityId: reading.id,
      details: {
        fuelType: reading.fuel_type,
        measuredLiters: reading.measured_liters,
        bookLiters: reading.book_liters,
        varianceLiters: reading.variance_liters,
        variancePct: reading.variance_pct,
        temperatureCelsius: reading.temperature_celsius,
        waterLevelMm: reading.water_level_mm,
        alarmRaised,
        waterAlarmRaised,
      },
      ip: req.ip,
      stationId: req.stationId,
    });

    res.status(201).json({ reading: serializeReading(reading, req.user!.username), alarmRaised, waterAlarmRaised });
  } catch (err) {
    if (err instanceof FuelStockError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const addSchema = z.object({
  liters: z.number().positive().max(100000),
  supplier: z.string().trim().min(2, "Tedarikci zorunludur.").max(120),
  deliveryRef: z.string().trim().max(60).optional(),
  note: z.string().max(300).optional(),
  unitCost: z.number().positive().max(1000).optional(),
  force: z.boolean().optional(),
  // Teslimat oncesi/sonrasi tank seviyesi. Ikisi de girilirse kabul farki hesaplanir;
  // yalnizca biri girilirse fark hesaplanamaz ve teslimat olculmemis sayilir.
  measuredBefore: z.number().min(0).max(1000000).optional(),
  measuredAfter: z.number().min(0).max(1000000).optional(),
});

router.post("/:fuelType/add", csrfProtection, validateBody(addSchema), (req, res) => {
  const fuelType = fuelTypeEnum.safeParse(req.params.fuelType);
  if (!fuelType.success) return void res.status(400).json({ error: "Gecersiz yakit tipi." });

  try {
    const { liters, supplier, deliveryRef, note, unitCost, force, measuredBefore, measuredAfter } = req.body as z.infer<
      typeof addSchema
    >;
    const { tank, overflow, variance } = addStock(
      req.stationId!,
      fuelType.data,
      liters,
      {
        supplier,
        deliveryRef: deliveryRef || null,
        note,
        unitCost: unitCost || null,
        force,
        measuredBefore,
        measuredAfter,
      },
      req.user!
    );
    recordAudit({
      user: req.user!,
      action: "fuel_stock_added",
      entityType: "fuel_tank",
      entityId: fuelType.data,
      // Irsaliye ve fiilen kabul edilen miktar AYRI kaydedilir: denetim izinde
      // "20.000 L geldi" ile "20.000 L yazildi, 19.600 L girdi" ayirt edilebilmeli.
      details: {
        declaredLiters: liters,
        acceptedLiters: variance.acceptedLiters,
        varianceLiters: variance.varianceLiters,
        overflow,
        supplier,
        deliveryRef,
        unitCost,
      },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ tank: serializeTank(tank), overflow, variance });
  } catch (err) {
    if (err instanceof DuplicateDeliveryRefError) {
      return void res.status(err.status).json({
        error: err.message,
        details: { duplicate: true, movementId: err.movementId, existingCreatedAt: err.existingCreatedAt },
      });
    }
    if (err instanceof FuelStockError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// --- Teslimat kabul farki: esikler ve tedarikci karnesi ---------------------

router.get("/delivery-variance/settings", (req, res) => {
  res.json({ settings: getDeliveryVarianceSettings(req.stationId!) });
});

const deliveryVarianceSettingsSchema = z.object({
  thresholdPct: z.number().min(0).max(100).optional(),
  minLiters: z.number().min(0).max(100000).optional(),
});

router.patch("/delivery-variance/settings", csrfProtection, validateBody(deliveryVarianceSettingsSchema), (req, res) => {
  try {
    const body = req.body as z.infer<typeof deliveryVarianceSettingsSchema>;
    const settings = updateDeliveryVarianceSettings(req.stationId!, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "delivery_variance_settings_updated",
      details: settings,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ settings });
  } catch (err) {
    if (err instanceof DeliveryVarianceError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const supplierVarianceQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.get("/delivery-variance/suppliers", validateQuery(supplierVarianceQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof supplierVarianceQuerySchema> }).validatedQuery;
  res.json({ suppliers: getSupplierDeliveryVariance(req.stationId!, q.from, q.to) });
});

// --- Tedarikciler ve siparisler ---------------------------------------------

router.get("/suppliers", (req, res) => {
  res.json({ suppliers: listSuppliers(req.stationId!).map(serializeSupplier) });
});

const supplierSchema = z.object({
  name: z.string().trim().min(2, "Tedarikci adi en az 2 karakter olmalidir.").max(120),
  email: z.string().trim().email("Gecerli bir e-posta girin.").max(200).optional(),
  phone: z.string().trim().max(20).optional(),
});

router.post("/suppliers", csrfProtection, validateBody(supplierSchema), (req, res) => {
  try {
    const supplier = createSupplier(req.stationId!, req.body as z.infer<typeof supplierSchema>, req.user!);
    recordAudit({
      user: req.user!,
      action: "fuel_supplier_created",
      entityType: "fuel_supplier",
      entityId: supplier.id,
      details: { name: supplier.name },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ supplier: serializeSupplier(supplier) });
  } catch (err) {
    if (err instanceof FuelOrderError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const supplierUpdateSchema = z.object({
  email: z.string().trim().email("Gecerli bir e-posta girin.").max(200).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  active: z.boolean().optional(),
});

router.patch("/suppliers/:id", csrfProtection, validateBody(supplierUpdateSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz tedarikci." });
  try {
    const supplier = updateSupplier(req.stationId!, id, req.body as z.infer<typeof supplierUpdateSchema>);
    res.json({ supplier: serializeSupplier(supplier) });
  } catch (err) {
    if (err instanceof FuelOrderError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

/** Siparis ONERISI - siparisin kendisi degil. Siparis vermek para taahhut etmektir. */
router.get("/orders/suggestions", (req, res) => {
  res.json({ suggestions: suggestions(req.stationId!) });
});

router.get("/orders", (req, res) => {
  res.json({ orders: listOrders(req.stationId!).map(serializeOrder) });
});

const orderSchema = z.object({
  fuelType: fuelTypeEnum,
  supplierId: z.number().int().positive(),
  liters: z.number().positive().max(100000),
  unitCost: z.number().positive().max(1000).optional(),
  expectedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.").optional(),
  note: z.string().trim().max(300).optional(),
});

router.post("/orders", csrfProtection, validateBody(orderSchema), (req, res) => {
  try {
    const body = req.body as z.infer<typeof orderSchema>;
    const order = createOrder(req.stationId!, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "fuel_order_created",
      entityType: "fuel_order",
      entityId: order.id,
      details: { fuelType: order.fuel_type, liters: order.ordered_liters, supplier: order.supplier_name },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ order: serializeOrder(order) });
  } catch (err) {
    if (err instanceof FuelOrderError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post("/orders/:id/send", csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz siparis." });
  try {
    const order = sendOrder(req.stationId!, id, req.user!);
    recordAudit({
      user: req.user!,
      action: "fuel_order_sent",
      entityType: "fuel_order",
      entityId: id,
      details: { supplier: order.supplier_name, liters: order.ordered_liters },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ order: serializeOrder(order) });
  } catch (err) {
    if (err instanceof FuelOrderError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post("/orders/:id/cancel", csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz siparis." });
  try {
    const order = cancelOrder(req.stationId!, id);
    recordAudit({
      user: req.user!,
      action: "fuel_order_cancelled",
      entityType: "fuel_order",
      entityId: id,
      details: { supplier: order.supplier_name, liters: order.ordered_liters },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ order: serializeOrder(order) });
  } catch (err) {
    if (err instanceof FuelOrderError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const receiveSchema = z.object({
  liters: z.number().positive().max(100000),
  deliveryRef: z.string().trim().max(60).optional(),
  note: z.string().max(300).optional(),
  unitCost: z.number().positive().max(1000).optional(),
  force: z.boolean().optional(),
  measuredBefore: z.number().min(0).max(1000000).optional(),
  measuredAfter: z.number().min(0).max(1000000).optional(),
});

/**
 * Siparisin teslim alinmasi. Mevcut teslimat yolunu (addStock) oldugu gibi kullanir:
 * kabul farki, irsaliye tekrari kontrolu ve maliyet ortalamasi degismeden calisir.
 */
router.post("/orders/:id/receive", csrfProtection, validateBody(receiveSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz siparis." });
  try {
    const body = req.body as z.infer<typeof receiveSchema>;
    const { order, overflow, variance } = receiveOrder(req.stationId!, id, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "fuel_order_received",
      entityType: "fuel_order",
      entityId: id,
      details: {
        orderedLiters: order.ordered_liters,
        declaredLiters: body.liters,
        acceptedLiters: variance.acceptedLiters,
        varianceLiters: variance.varianceLiters,
        supplier: order.supplier_name,
      },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ order: serializeOrder(order), overflow, variance });
  } catch (err) {
    if (err instanceof DuplicateDeliveryRefError) {
      return void res.status(err.status).json({
        error: err.message,
        details: { duplicate: true, movementId: err.movementId, existingCreatedAt: err.existingCreatedAt },
      });
    }
    if (err instanceof FuelOrderError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof FuelStockError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const adjustSchema = z.object({
  newLiters: z.number().min(0).max(1000000),
  note: z.string().trim().min(3, "Aciklama zorunludur.").max(300),
});

router.post("/:fuelType/adjust", csrfProtection, validateBody(adjustSchema), (req, res) => {
  const fuelType = fuelTypeEnum.safeParse(req.params.fuelType);
  if (!fuelType.success) return void res.status(400).json({ error: "Gecersiz yakit tipi." });

  try {
    const { newLiters, note } = req.body as z.infer<typeof adjustSchema>;
    const tank = adjustStock(req.stationId!, fuelType.data, newLiters, note, req.user!);
    recordAudit({
      user: req.user!,
      action: "fuel_stock_adjusted",
      entityType: "fuel_tank",
      entityId: fuelType.data,
      details: { newLiters, note },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ tank: serializeTank(tank) });
  } catch (err) {
    if (err instanceof FuelStockError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const settingsSchema = z.object({
  capacityLiters: z.number().positive().max(1000000).optional(),
  lowStockThresholdLiters: z.number().min(0).max(1000000).optional(),
});

router.patch("/:fuelType/settings", csrfProtection, validateBody(settingsSchema), (req, res) => {
  const fuelType = fuelTypeEnum.safeParse(req.params.fuelType);
  if (!fuelType.success) return void res.status(400).json({ error: "Gecersiz yakit tipi." });

  try {
    const body = req.body as z.infer<typeof settingsSchema>;
    const tank = updateTankSettings(req.stationId!, fuelType.data, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "fuel_tank_settings_updated",
      entityType: "fuel_tank",
      entityId: fuelType.data,
      details: body,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ tank: serializeTank(tank) });
  } catch (err) {
    if (err instanceof FuelStockError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const deliveryRefSchema = z.object({
  deliveryRef: z.string().trim().max(60).nullable(),
  force: z.boolean().optional(),
});

router.patch("/movements/:id/delivery-ref", csrfProtection, validateBody(deliveryRefSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hareket." });
  try {
    const { deliveryRef, force } = req.body as z.infer<typeof deliveryRefSchema>;
    const movement = setDeliveryRef(id, req.stationId!, deliveryRef || null, !!force);
    recordAudit({
      user: req.user!,
      action: "fuel_stock_delivery_ref_updated",
      entityType: "fuel_stock_movement",
      entityId: String(movement.id),
      details: { deliveryRef: movement.delivery_ref },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ deliveryRef: movement.delivery_ref });
  } catch (err) {
    if (err instanceof DuplicateDeliveryRefError) {
      return void res.status(err.status).json({
        error: err.message,
        details: { duplicate: true, movementId: err.movementId, existingCreatedAt: err.existingCreatedAt },
      });
    }
    if (err instanceof FuelStockError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.get("/movements/:id/waybill", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hareket." });
  try {
    const movement = getMovementById(id, req.stationId!);
    const waybill = getWaybillForMovement(movement.id);
    res.json({ waybill: waybill ? serializeWaybill(waybill) : null });
  } catch (err) {
    if (err instanceof FuelStockError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post("/movements/:id/waybill", csrfProtection, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hareket." });
  let movement;
  try {
    movement = getMovementById(id, req.stationId!);
  } catch (err) {
    if (err instanceof FuelStockError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
  try {
    const result = await createWaybill(movement);
    const waybill = recordWaybillSuccess(movement.station_id, movement.id, result.providerWaybillId, req.user!);
    recordAudit({
      user: req.user!,
      action: "waybill_created",
      entityType: "fuel_stock_movement",
      entityId: String(movement.id),
      details: { providerWaybillId: result.providerWaybillId },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ waybill: serializeWaybill(waybill) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Irsaliye olusturulamadi.";
    const status = err instanceof WaybillError ? err.status : 502;
    recordWaybillFailure(movement.station_id, movement.id, message, req.user!);
    recordAudit({
      user: req.user!,
      action: "waybill_failed",
      entityType: "fuel_stock_movement",
      entityId: String(movement.id),
      details: { error: message },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(status).json({ error: message });
  }
});

export { router as fuelStockRouter };
