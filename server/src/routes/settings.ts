import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { FuelPriceRow } from "../db/types.js";
import { attachStationScope, requireAuth, requireRole, requireStationSelected, csrfProtection } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import { resetDemoData } from "../services/demoResetService.js";
import { getIyzicoConfig, serializeIyzicoConfig, setIyzicoConfig } from "../services/paymentSettingsService.js";
import { getInvoiceConfig, serializeInvoiceConfig, setInvoiceConfig } from "../services/invoiceSettingsService.js";
import { getReportEmailConfig, setReportEmailFrequency } from "../services/reportEmailService.js";
import { ScheduledPriceError, cancelSchedule, createSchedule, listSchedules, serializeSchedule } from "../services/scheduledPriceService.js";
import { broadcastFuelPrices } from "../services/fuelPriceService.js";

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
  // Kiosk'taki fiyat seffafligi ekrani icin - bkz. GET /api/kiosk/fuel-prices/history.
  db.prepare("INSERT INTO fuel_price_history (station_id, fuel_type, price_per_liter, changed_by) VALUES (?, ?, ?, ?)").run(
    req.stationId!,
    fuelType,
    pricePerLiter,
    req.user!.id
  );
  recordAudit({
    user: req.user!,
    action: "fuel_price_updated",
    entityType: "fuel_price",
    entityId: fuelType,
    details: { oldPricePerLiter: existing.price_per_liter, newPricePerLiter: pricePerLiter },
    ip: req.ip,
    stationId: req.stationId,
  });
  broadcastFuelPrices(req.stationId!);
  res.json({ ok: true });
});

router.get("/fuel-prices/scheduled", (req, res) => {
  res.json({ schedules: listSchedules(req.stationId!).map(serializeSchedule) });
});

const scheduleSchema = z.object({
  fuelType: z.enum(["benzin", "motorin", "lpg"]),
  pricePerLiter: z.number().positive().max(1000),
  scheduledFor: z.string().datetime({ message: "Gecerli bir ISO tarih/saat giriniz." }).or(z.string().min(1)),
});

router.post("/fuel-prices/scheduled", validateBody(scheduleSchema), (req, res) => {
  const body = req.body as z.infer<typeof scheduleSchema>;
  try {
    const schedule = createSchedule(req.stationId!, body.fuelType, body.pricePerLiter, body.scheduledFor, req.user!);
    recordAudit({
      user: req.user!,
      action: "fuel_price_scheduled",
      entityType: "fuel_price",
      entityId: body.fuelType,
      details: body,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ schedule: serializeSchedule(schedule) });
  } catch (err) {
    if (err instanceof ScheduledPriceError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.delete("/fuel-prices/scheduled/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz planlama kimligi." });
  try {
    cancelSchedule(req.stationId!, id);
    recordAudit({ user: req.user!, action: "fuel_price_schedule_cancelled", entityType: "fuel_price", entityId: id, ip: req.ip, stationId: req.stationId });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ScheduledPriceError) return void res.status(err.status).json({ error: err.message });
    throw err;
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

router.get("/report-email", (req, res) => {
  res.json(getReportEmailConfig(req.stationId!));
});

const reportEmailSchema = z.object({ frequency: z.enum(["none", "weekly", "monthly"]) });

router.patch("/report-email", validateBody(reportEmailSchema), (req, res) => {
  const { frequency } = req.body as z.infer<typeof reportEmailSchema>;
  setReportEmailFrequency(req.stationId!, frequency, req.user!);
  recordAudit({ user: req.user!, action: "report_email_frequency_updated", details: { frequency }, ip: req.ip, stationId: req.stationId });
  res.json(getReportEmailConfig(req.stationId!));
});

router.get("/invoice", (req, res) => {
  res.json({ config: serializeInvoiceConfig(getInvoiceConfig(req.stationId!)) });
});

const invoiceConfigSchema = z.object({
  enabled: z.boolean().optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
  username: z.string().min(1).max(200).optional(),
  password: z.string().min(1).max(200).optional(),
  companyVkn: z.string().min(1).max(20).optional(),
  companyTitle: z.string().min(1).max(200).optional(),
  companyTaxOffice: z.string().min(1).max(100).optional(),
  companyAddress: z.string().min(1).max(300).optional(),
  companyCity: z.string().min(1).max(100).optional(),
  companyDistrict: z.string().min(1).max(100).optional(),
});

router.patch("/invoice", validateBody(invoiceConfigSchema), (req, res) => {
  const body = req.body as z.infer<typeof invoiceConfigSchema>;
  setInvoiceConfig(req.stationId!, body, req.user!);
  recordAudit({
    user: req.user!,
    action: "invoice_config_updated",
    details: { enabled: body.enabled, environment: body.environment, usernameChanged: !!body.username, passwordChanged: !!body.password },
    ip: req.ip,
    stationId: req.stationId,
  });
  res.json({ config: serializeInvoiceConfig(getInvoiceConfig(req.stationId!)) });
});

const resetSchema = z.object({ confirm: z.literal(true) });

router.post("/demo-reset", requireRole("super_admin"), validateBody(resetSchema), (req, res) => {
  resetDemoData(req.stationId!);
  recordAudit({ user: req.user!, action: "demo_data_reset", ip: req.ip, stationId: req.stationId });
  res.status(204).end();
});

export { router as settingsRouter };
