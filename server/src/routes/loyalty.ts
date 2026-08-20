import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  LoyaltyError,
  adjustPoints,
  getLoyaltyConfig,
  listMovements,
  serializeAccount,
  serializeMovement,
  setLoyaltyConfig,
} from "../services/loyaltyService.js";

const router = Router();
// Sadakat programi yalnizca istasyon yoneticisine (admin) ve platform yoneticisine
// (super_admin) acik; operator/viewer goremez/duzenleyemez.
router.use(requireAuth, requireRole("super_admin", "admin"), attachStationScope, requireStationSelected);

router.get("/config", (req, res) => {
  res.json({ config: getLoyaltyConfig(req.stationId!) });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  pointsPerLiter: z.number().min(0).max(1000).optional(),
  pointValueTry: z.number().min(0).max(100).optional(),
});

router.patch("/config", csrfProtection, validateBody(configSchema), (req, res) => {
  const body = req.body as z.infer<typeof configSchema>;
  const config = setLoyaltyConfig(req.stationId!, body, req.user!);
  recordAudit({ user: req.user!, action: "loyalty_config_updated", details: body, ip: req.ip, stationId: req.stationId });
  res.json({ config });
});

const movementsQuerySchema = z.object({
  plate: z.string().max(15).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

router.get("/movements", validateQuery(movementsQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof movementsQuerySchema> }).validatedQuery;
  const rows = listMovements(req.stationId!, q);
  res.json({ movements: rows.map(serializeMovement) });
});

router.get("/accounts/:plate", (req, res) => {
  res.json({ account: serializeAccount(req.stationId!, req.params.plate ?? "") });
});

const adjustSchema = z.object({
  newPoints: z.number().min(0).max(1000000),
  note: z.string().trim().min(3, "Aciklama zorunludur.").max(300),
});

router.post("/accounts/:plate/adjust", csrfProtection, validateBody(adjustSchema), (req, res) => {
  try {
    const { newPoints, note } = req.body as z.infer<typeof adjustSchema>;
    const account = adjustPoints(req.stationId!, req.params.plate ?? "", newPoints, note, req.user!);
    recordAudit({
      user: req.user!,
      action: "loyalty_points_adjusted",
      entityType: "loyalty_account",
      entityId: account.plate,
      details: { newPoints, note },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ account: serializeAccount(req.stationId!, account.plate) });
  } catch (err) {
    if (err instanceof LoyaltyError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as loyaltyRouter };
