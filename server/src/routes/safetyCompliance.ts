import { Router } from "express";
import { z } from "zod";
import { attachStationScope, requireAuth, requireRole, requireStationSelected, csrfProtection } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  SAFETY_COMPLIANCE_ITEMS,
  SafetyComplianceError,
  getFireExtinguisherRequirement,
  getStationComplianceStatus,
  listCompliance,
  recordCompliance,
  serializeComplianceRecord,
  setFireExtinguisherRequirement,
  type SafetyComplianceItemType,
} from "../services/safetyComplianceService.js";
import { buildComplianceReportCsv, buildComplianceReportData, buildComplianceReportPdf } from "../services/complianceReportService.js";
import { db } from "../db/index.js";
import type { StationRow } from "../db/types.js";

const router = Router();
router.use(requireAuth, attachStationScope, requireStationSelected, csrfProtection);

const ITEM_TYPES = SAFETY_COMPLIANCE_ITEMS.map((i) => i.type) as [SafetyComplianceItemType, ...SafetyComplianceItemType[]];

router.get("/", (req, res) => {
  res.json({
    items: SAFETY_COMPLIANCE_ITEMS,
    status: getStationComplianceStatus(req.stationId!),
    fireExtinguisherRequirement: getFireExtinguisherRequirement(req.stationId!),
  });
});

const fireExtinguisherRequirementSchema = z.object({
  requiredCount: z.number().int().min(0).max(1000).nullable(),
  locations: z.string().trim().max(500).nullable(),
});

router.patch(
  "/fire-extinguisher-requirement",
  requireRole("super_admin", "tenant_admin", "admin"),
  validateBody(fireExtinguisherRequirementSchema),
  (req, res) => {
    const body = req.body as z.infer<typeof fireExtinguisherRequirementSchema>;
    try {
      const requirement = setFireExtinguisherRequirement(req.stationId!, body);
      recordAudit({
        user: req.user!,
        action: "fire_extinguisher_requirement_updated",
        entityType: "station",
        entityId: req.stationId!,
        details: body,
        ip: req.ip,
        stationId: req.stationId,
      });
      res.json({ fireExtinguisherRequirement: requirement });
    } catch (err) {
      if (err instanceof SafetyComplianceError) return void res.status(err.status).json({ error: err.message });
      throw err;
    }
  }
);

/**
 * Uyum Panosu'nun (Emniyet Uyum Takvimi + pompa kalibrasyon/damga + acik alarmlar)
 * denetci ziyaretinde goturulebilecek PDF/CSV disa aktarimi. Ekranin kendisiyle AYNI
 * ucu KULLANMAZ - ayri bir istek olsa da, tamamen ayni 3 sorguyu (getStationComplianceStatus,
 * getStationCalibrationStatus, listAlarms) birlestirir; yeni bir veri kaynagi eklemez.
 */
router.get("/report.pdf", async (req, res) => {
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(req.stationId!);
  if (!station) return void res.status(404).json({ error: "Istasyon bulunamadi." });
  const data = buildComplianceReportData(station);
  const pdf = await buildComplianceReportPdf(data);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="uyum-raporu-${Date.now()}.pdf"`);
  res.send(pdf);
});

router.get("/report.csv", (req, res) => {
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(req.stationId!);
  if (!station) return void res.status(404).json({ error: "Istasyon bulunamadi." });
  const data = buildComplianceReportData(station);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="uyum-raporu-${Date.now()}.csv"`);
  res.send(buildComplianceReportCsv(data));
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
