import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import { KvkkError, eraseByPlate, lookupPersonalData } from "../services/kvkkService.js";
import {
  DataRetentionError,
  getRetentionSettings,
  previewRetention,
  sweepStation,
  updateRetentionSettings,
} from "../services/dataRetentionService.js";

const router = Router();
// KVKK veri sahibi basvurulari (erisim/silme) hassas oldugu icin yalnizca istasyon
// yoneticisi (admin) ve platform yoneticisine (super_admin) acik.
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected);

// --- Saklama suresi (otomatik imha) -----------------------------------------
// Parametreli yollardan ONCE tanimlanir ki "retention" bir plaka olarak yorumlanmasin.

router.get("/retention", (req, res) => {
  res.json({
    settings: getRetentionSettings(req.stationId!),
    // Onizleme ayni yanitta: geri donulemez bir islemi acmadan once "bu ne kadar veriyi
    // etkiler" sorusunun cevabi ekranda durmali.
    preview: previewRetention(req.stationId!),
  });
});

const retentionSchema = z.object({
  enabled: z.boolean().optional(),
  retentionMonths: z.number().int().min(6).max(240).optional(),
});

router.patch("/retention", csrfProtection, validateBody(retentionSchema), (req, res) => {
  try {
    const body = req.body as z.infer<typeof retentionSchema>;
    const settings = updateRetentionSettings(req.stationId!, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "kvkk_retention_settings_updated",
      details: settings,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ settings, preview: previewRetention(req.stationId!) });
  } catch (err) {
    if (err instanceof DataRetentionError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

/** Elle calistirma: bir sonraki gunluk taramayi beklemeden uygulamak icin. */
router.post("/retention/run", csrfProtection, (req, res) => {
  const result = sweepStation(req.stationId!);
  if (!result) return void res.status(409).json({ error: "Saklama suresi uygulamasi kapali." });
  recordAudit({
    user: req.user!,
    action: "kvkk_retention_applied",
    details: result,
    ip: req.ip,
    stationId: req.stationId,
  });
  res.json({ result, preview: previewRetention(req.stationId!) });
});

router.get("/lookup/:plate", (req, res) => {
  try {
    const report = lookupPersonalData(req.stationId!, req.params.plate ?? "");
    recordAudit({
      user: req.user!,
      action: "kvkk_data_accessed",
      entityType: "plate",
      entityId: report.plate,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ report });
  } catch (err) {
    if (err instanceof KvkkError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const eraseSchema = z.object({ reason: z.string().trim().min(3, "Talep gerekcesi zorunludur.").max(300) });

router.post("/erase/:plate", csrfProtection, validateBody(eraseSchema), (req, res) => {
  try {
    const { reason } = req.body as z.infer<typeof eraseSchema>;
    const result = eraseByPlate(req.stationId!, req.params.plate ?? "");
    recordAudit({
      user: req.user!,
      action: "kvkk_data_erased",
      entityType: "plate",
      entityId: result.plate,
      details: { reason, ...result },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ result });
  } catch (err) {
    if (err instanceof KvkkError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as kvkkRouter };
