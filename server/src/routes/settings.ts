import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { FuelPriceRow } from "../db/types.js";
import { requireAuth, requireRole, csrfProtection } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import { resetDemoData } from "../services/demoResetService.js";

const router = Router();
router.use(requireAuth, requireRole("admin"), csrfProtection);

router.get("/fuel-prices", (_req, res) => {
  const rows = db.prepare<[], FuelPriceRow>("SELECT * FROM fuel_prices").all();
  res.json({ fuelPrices: rows.map((r) => ({ fuelType: r.fuel_type, label: r.label, pricePerLiter: r.price_per_liter, updatedAt: r.updated_at })) });
});

const priceSchema = z.object({ pricePerLiter: z.number().positive().max(1000) });

router.patch("/fuel-prices/:fuelType", validateBody(priceSchema), (req, res) => {
  const fuelType = req.params.fuelType ?? "";
  const existing = db.prepare<[string], FuelPriceRow>("SELECT * FROM fuel_prices WHERE fuel_type = ?").get(fuelType);
  if (!existing) return void res.status(404).json({ error: "Gecersiz yakit tipi." });

  const { pricePerLiter } = req.body as z.infer<typeof priceSchema>;
  db.prepare("UPDATE fuel_prices SET price_per_liter = ?, updated_at = ? WHERE fuel_type = ?").run(
    pricePerLiter,
    new Date().toISOString(),
    fuelType
  );
  recordAudit({ user: req.user!, action: "fuel_price_updated", entityType: "fuel_price", entityId: fuelType, details: { pricePerLiter }, ip: req.ip });
  res.json({ ok: true });
});

const resetSchema = z.object({ confirm: z.literal(true) });

router.post("/demo-reset", validateBody(resetSchema), (req, res) => {
  resetDemoData();
  recordAudit({ user: req.user!, action: "demo_data_reset", ip: req.ip });
  res.status(204).end();
});

export { router as settingsRouter };
