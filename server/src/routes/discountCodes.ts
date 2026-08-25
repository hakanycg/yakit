import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import { DiscountError, createCode, getUsageStats, listCodes, serializeCode, setCodeActive } from "../services/discountService.js";

const router = Router();
// Kampanya kodlari yalnizca istasyon yoneticisine (admin) ve platform yoneticisine
// (super_admin) acik; operator/viewer goremez/duzenleyemez.
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected);

router.get("/", (req, res) => {
  const stats = getUsageStats(req.stationId!);
  const codes = listCodes(req.stationId!).map((c) => ({
    ...serializeCode(c),
    stats: stats.get(c.id) ?? { completedUses: 0, totalDiscountGiven: 0, revenueGenerated: 0 },
  }));
  res.json({ codes });
});

const fuelTypeEnum = z.enum(["benzin", "motorin", "lpg"]);

const createSchema = z.object({
  code: z.string().trim().min(3, "Kod en az 3 karakter olmalidir.").max(30),
  type: z.enum(["percent", "fixed"]),
  value: z.number().positive().max(100000),
  fuelType: fuelTypeEnum.optional(),
  maxUses: z.number().int().positive().max(1000000).optional(),
  startsAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});

router.post("/", csrfProtection, validateBody(createSchema), (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;
  if (body.type === "percent" && body.value > 100) {
    res.status(400).json({ error: "Yuzde indirim 100'den buyuk olamaz." });
    return;
  }
  try {
    const code = createCode(req.stationId!, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "discount_code_created",
      entityType: "discount_code",
      entityId: code.code,
      details: body,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ code: serializeCode(code) });
  } catch (err) {
    if (err instanceof DiscountError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const activeSchema = z.object({ active: z.boolean() });

router.patch("/:id/active", csrfProtection, validateBody(activeSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz kod kimligi." });
  try {
    const { active } = req.body as z.infer<typeof activeSchema>;
    const code = setCodeActive(req.stationId!, id, active);
    recordAudit({
      user: req.user!,
      action: active ? "discount_code_activated" : "discount_code_deactivated",
      entityType: "discount_code",
      entityId: code.code,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ code: serializeCode(code) });
  } catch (err) {
    if (err instanceof DiscountError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as discountCodesRouter };
