import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  ADVANCE_KINDS,
  StaffAdvanceError,
  createEntry,
  deleteEntry,
  getStaffBalances,
  listEntriesPaged,
  serializeEntry,
  settleEntry,
} from "../services/staffAdvanceService.js";
import { csvEscape } from "../utils/csv.js";

const router = Router();
// Mali veri: operator/viewer goremez - expenses.ts/supplierLedger.ts/cashAccounts.ts/
// profitLoss.ts/vat.ts ile ayni gerekce, on muhasebe serisinin tutarliligi icin.
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected);

const kindEnum = z.enum(ADVANCE_KINDS);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.");

router.get("/balances", (req, res) => {
  res.json({ balances: getStaffBalances(req.stationId!) });
});

const listQuerySchema = z.object({
  userId: z.coerce.number().int().positive().optional(),
  kind: kindEnum.optional(),
  settled: z.coerce.boolean().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

router.get("/", validateQuery(listQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listQuerySchema> }).validatedQuery;
  const result = listEntriesPaged(req.stationId!, q);
  res.json({
    entries: result.entries.map(serializeEntry),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
});

router.get("/export.csv", validateQuery(listQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listQuerySchema> }).validatedQuery;
  const rows = listEntriesPaged(req.stationId!, { ...q, pageSize: 200, page: 1 }).entries;

  const kindLabel: Record<string, string> = { avans: "Avans", masraf: "Masraf" };
  const header = ["id", "personel", "tur", "tutar", "tarih", "durum", "aciklama", "olusturulma"];
  const lines = [header.join(",")];
  for (const e of rows) {
    lines.push(
      [
        e.id,
        e.display_name,
        kindLabel[e.kind] ?? e.kind,
        e.amount,
        e.entry_date,
        e.settled ? "Kapandi" : "Acik",
        e.description,
        e.created_at,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  recordAudit({
    user: req.user!,
    action: "staff_advances_exported",
    details: { count: rows.length },
    ip: req.ip,
    stationId: req.stationId,
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="personel-avans-masraf-${Date.now()}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

const createEntrySchema = z.object({
  userId: z.number().int().positive(),
  kind: kindEnum,
  amount: z.number().positive().max(10_000_000),
  description: z.string().trim().max(300).optional(),
  entryDate: dateSchema,
});

router.post("/", csrfProtection, validateBody(createEntrySchema), (req, res) => {
  try {
    const body = req.body as z.infer<typeof createEntrySchema>;
    const entry = createEntry(req.stationId!, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "staff_advance_created",
      entityType: "staff_advance",
      entityId: entry.id,
      details: { userId: entry.user_id, kind: entry.kind, amount: entry.amount },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ entry: serializeEntry(entry) });
  } catch (err) {
    if (err instanceof StaffAdvanceError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.patch("/:id", csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz kayit." });
  try {
    const entry = settleEntry(req.stationId!, id);
    recordAudit({
      user: req.user!,
      action: "staff_advance_settled",
      entityType: "staff_advance",
      entityId: id,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ entry: serializeEntry(entry) });
  } catch (err) {
    if (err instanceof StaffAdvanceError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.delete("/:id", csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz kayit." });
  try {
    deleteEntry(req.stationId!, id);
    recordAudit({
      user: req.user!,
      action: "staff_advance_deleted",
      entityType: "staff_advance",
      entityId: id,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof StaffAdvanceError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as staffAdvancesRouter };
