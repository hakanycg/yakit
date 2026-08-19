import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { FuelPriceRow } from "../db/types.js";
import { attachStationScope, requireAuth, requireRole, requireStationSelected, csrfProtection } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import { resetDemoData } from "../services/demoResetService.js";
import {
  TURKEY_CITIES,
  getFuelSyncConfig,
  getSetting,
  runFuelPriceSync,
  setFuelSyncConfig,
} from "../services/fuelSyncService.js";
import { getIyzicoConfig, serializeIyzicoConfig, setIyzicoConfig } from "../services/paymentSettingsService.js";

const router = Router();
router.use(requireAuth, requireRole("super_admin", "admin"), attachStationScope, requireStationSelected, csrfProtection);

router.get("/fuel-prices", (req, res) => {
  const rows = db.prepare<[number], FuelPriceRow>("SELECT * FROM fuel_prices WHERE station_id = ?").all(req.stationId!);
  res.json({ fuelPrices: rows.map((r) => ({ fuelType: r.fuel_type, label: r.label, pricePerLiter: r.price_per_liter, updatedAt: r.updated_at })) });
});

const priceSchema = z.object({ pricePerLiter: z.number().positive().max(1000) });

router.patch("/fuel-prices/:fuelType", validateBody(priceSchema), (req, res) => {
  const fuelType = req.params.fuelType ?? "";
  const existing = db
    .prepare<[number, string], FuelPriceRow>("SELECT * FROM fuel_prices WHERE station_id = ? AND fuel_type = ?")
    .get(req.stationId!, fuelType);
  if (!existing) return void res.status(404).json({ error: "Gecersiz yakit tipi." });

  const { pricePerLiter } = req.body as z.infer<typeof priceSchema>;
  db.prepare("UPDATE fuel_prices SET price_per_liter = ?, updated_at = ? WHERE station_id = ? AND fuel_type = ?").run(
    pricePerLiter,
    new Date().toISOString(),
    req.stationId!,
    fuelType
  );
  recordAudit({
    user: req.user!,
    action: "fuel_price_updated",
    entityType: "fuel_price",
    entityId: fuelType,
    details: { pricePerLiter },
    ip: req.ip,
    stationId: req.stationId,
  });
  res.json({ ok: true });
});

router.get("/fuel-sync", (req, res) => {
  const stationId = req.stationId!;
  const summary = getSetting(stationId, "fuel_sync_last_summary");
  res.json({
    config: getFuelSyncConfig(stationId),
    cities: TURKEY_CITIES,
    lastRunAt: getSetting(stationId, "fuel_sync_last_run_at"),
    lastStatus: getSetting(stationId, "fuel_sync_last_status"),
    lastSummary: summary ? JSON.parse(summary) : null,
  });
});

const fuelSyncConfigSchema = z.object({
  enabled: z.boolean().optional(),
  city: z.enum(TURKEY_CITIES).optional(),
  intervalMinutes: z.number().int().min(15).max(1440).optional(),
});

router.patch("/fuel-sync", validateBody(fuelSyncConfigSchema), (req, res) => {
  const body = req.body as z.infer<typeof fuelSyncConfigSchema>;
  setFuelSyncConfig(req.stationId!, body, req.user!);
  recordAudit({ user: req.user!, action: "fuel_sync_config_updated", details: body, ip: req.ip, stationId: req.stationId });
  res.json({ config: getFuelSyncConfig(req.stationId!) });
});

router.post("/fuel-sync/run-now", async (req, res) => {
  const stationId = req.stationId!;
  const config = getFuelSyncConfig(stationId);
  try {
    const result = await runFuelPriceSync(stationId, config.city, req.user!);
    res.json({ result });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Senkronizasyon basarisiz." });
  }
});

router.get("/payment", (req, res) => {
  res.json({ config: serializeIyzicoConfig(getIyzicoConfig(req.stationId!)) });
});

const paymentConfigSchema = z.object({
  enabled: z.boolean().optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
  apiKey: z.string().min(4).max(200).optional(),
  secretKey: z.string().min(4).max(200).optional(),
});

router.patch("/payment", validateBody(paymentConfigSchema), (req, res) => {
  const body = req.body as z.infer<typeof paymentConfigSchema>;
  setIyzicoConfig(req.stationId!, body, req.user!);
  recordAudit({
    user: req.user!,
    action: "payment_config_updated",
    details: { enabled: body.enabled, environment: body.environment, apiKeyChanged: !!body.apiKey, secretKeyChanged: !!body.secretKey },
    ip: req.ip,
    stationId: req.stationId,
  });
  res.json({ config: serializeIyzicoConfig(getIyzicoConfig(req.stationId!)) });
});

const resetSchema = z.object({ confirm: z.literal(true) });

router.post("/demo-reset", validateBody(resetSchema), (req, res) => {
  resetDemoData(req.stationId!);
  recordAudit({ user: req.user!, action: "demo_data_reset", ip: req.ip, stationId: req.stationId });
  res.status(204).end();
});

export { router as settingsRouter };
