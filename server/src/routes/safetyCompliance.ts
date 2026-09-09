import { Router } from "express";
import { z } from "zod";
import { attachStationScope, requireAuth, requireRole, requireStationSelected, csrfProtection } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  SAFETY_COMPLIANCE_ITEMS,
  SafetyComplianceError,
  getStationComplianceStatus,
  listCompliance,
  recordCompliance,
  serializeComplianceRecord,
  type SafetyComplianceItemType,
} from "../services/safetyComplianceService.js";

const router = Router();
router.use(requireAuth, attachStationScope, requireStationSelected, csrfProtection);

const ITEM_TYPES = SAFETY_COMPLIANCE_ITEMS.map((i) => i.type) as [SafetyComplianceItemType, ...SafetyComplianceItemType[]];

router.get("/", (req, res) => {
  res.json({ items: SAFETY_COMPLIANCE_ITEMS, status: getStationComplianceStatus(req.stationId!) });
});

router.get("/:itemType/records", (req, res) => {
  const itemType = req.params.itemType as SafetyComplianceItemType;
  try {
    res.json({ records: listCompliance(req.stationId!, itemType).map(serializeComplianceRecord) });
  } catch (err) {
    if (err instanceof SafetyComplianceError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const recordSchema = z.object({
  itemType: z.enum(ITEM_TYPES),
  completedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  intervalMonths: z.number().int().min(1).max(120).optional(),
  reference: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
});

// csrfProtection router genelinde zaten uygulaniyor (yukaridaki router.use).
router.post("/records", requireRole("super_admin", "tenant_admin", "admin"), validateBody(recordSchema), (req, res) => {
  const body = req.body as z.infer<typeof recordSchema>;
  try {
    const record = recordCompliance(
      req.stationId!,
      {
        itemType: body.itemType,
        // Tarih gun bazinda girilir; gunun SONU kabul edilir - pompa damgasindaki aynen ayni ilke.
        completedAt: `${body.completedAt}T23:59:59.000Z`,
        intervalMonths: body.intervalMonths,
        reference: body.reference || null,
        note: body.note || null,
      },
      req.user!
    );
    recordAudit({
      user: req.user!,
      action: "safety_compliance_recorded",
      entityType: "safety_compliance",
      entityId: body.itemType,
      details: { itemType: body.itemType, completedAt: body.completedAt, intervalMonths: record.interval_months },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ record: serializeComplianceRecord(record) });
  } catch (err) {
    if (err instanceof SafetyComplianceError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as safetyComplianceRouter };
