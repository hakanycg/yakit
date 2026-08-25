import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  ReconciliationError,
  closeDay,
  currentBusinessDate,
  getDaySummary,
  listReconciliations,
} from "../services/reconciliationService.js";

/**
 * Gun sonu kasa/odeme mutabakati. Para hareketiyle ilgili oldugundan yakit stogu gibi
 * yalnizca istasyon yoneticisine (ve her zaman gecen platform yoneticisine) acilir.
 */
const router = Router();
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.");

const summaryQuerySchema = z.object({ date: dateSchema.optional() });

router.get("/summary", validateQuery(summaryQuerySchema), (req, res) => {
  const { date } = (req as unknown as { validatedQuery: z.infer<typeof summaryQuerySchema> }).validatedQuery;
  res.json({ summary: getDaySummary(req.stationId!, date ?? currentBusinessDate()) });
});

const historyQuerySchema = z.object({ limit: z.coerce.number().int().positive().max(365).optional() });

router.get("/", validateQuery(historyQuerySchema), (req, res) => {
  const { limit } = (req as unknown as { validatedQuery: z.infer<typeof historyQuerySchema> }).validatedQuery;
  res.json({ reconciliations: listReconciliations(req.stationId!, limit) });
});

router.get("/export.csv", (req, res) => {
  const rows = listReconciliations(req.stationId!, 365);
  const header = ["is_gunu", "beklenen_tutar", "gerceklesen_tutar", "fark", "askida_islem", "not", "kapatan", "kapatma_zamani"];
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [r.businessDate, r.expectedTotal, r.declaredTotal, r.difference, r.pendingCount, r.note, r.closedBy, r.closedAt]
        .map(escape)
        .join(",")
    );
  }

  recordAudit({ user: req.user!, action: "reconciliations_exported", details: { count: rows.length }, ip: req.ip, stationId: req.stationId });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="gun-sonu-mutabakat-${Date.now()}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

const closeSchema = z.object({
  businessDate: dateSchema,
  declaredTotal: z.number().min(0).max(100000000),
  note: z.string().max(500).optional(),
});

router.post("/close", csrfProtection, validateBody(closeSchema), (req, res) => {
  try {
    const { businessDate, declaredTotal, note } = req.body as z.infer<typeof closeSchema>;
    const record = closeDay({ stationId: req.stationId!, businessDate, declaredTotal, note, actor: req.user! });

    recordAudit({
      user: req.user!,
      action: "reconciliation_day_closed",
      entityType: "daily_reconciliation",
      entityId: record.id,
      details: {
        businessDate: record.businessDate,
        expectedTotal: record.expectedTotal,
        declaredTotal: record.declaredTotal,
        difference: record.difference,
        pendingCount: record.pendingCount,
      },
      ip: req.ip,
      stationId: req.stationId,
    });

    res.status(201).json({ reconciliation: record });
  } catch (err) {
    if (err instanceof ReconciliationError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export const reconciliationRouter = router;
