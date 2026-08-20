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
import { createWaybill, WaybillError } from "../services/waybillService.js";
import { getWaybillForMovement, recordWaybillFailure, recordWaybillSuccess, serializeWaybill } from "../services/waybillRecordService.js";

const router = Router();
// Yakit stogu yalnizca istasyon yoneticisine (admin) ve platform yoneticisine (super_admin,
// her zaman gectigi icin) acik; operator/viewer bu sayfayi goremez/duzenleyemez.
router.use(requireAuth, requireRole("super_admin", "admin"), attachStationScope, requireStationSelected);

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

const addSchema = z.object({
  liters: z.number().positive().max(100000),
  supplier: z.string().trim().min(2, "Tedarikci zorunludur.").max(120),
  deliveryRef: z.string().trim().max(60).optional(),
  note: z.string().max(300).optional(),
  unitCost: z.number().positive().max(1000).optional(),
  force: z.boolean().optional(),
});

router.post("/:fuelType/add", csrfProtection, validateBody(addSchema), (req, res) => {
  const fuelType = fuelTypeEnum.safeParse(req.params.fuelType);
  if (!fuelType.success) return void res.status(400).json({ error: "Gecersiz yakit tipi." });

  try {
    const { liters, supplier, deliveryRef, note, unitCost, force } = req.body as z.infer<typeof addSchema>;
    const { tank, overflow } = addStock(
      req.stationId!,
      fuelType.data,
      liters,
      { supplier, deliveryRef: deliveryRef || null, note, unitCost: unitCost || null, force },
      req.user!
    );
    recordAudit({
      user: req.user!,
      action: "fuel_stock_added",
      entityType: "fuel_tank",
      entityId: fuelType.data,
      details: { liters, overflow, supplier, deliveryRef, unitCost },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ tank: serializeTank(tank), overflow });
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
