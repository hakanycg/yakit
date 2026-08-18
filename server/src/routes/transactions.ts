import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { listTransactions, serializeTransaction } from "../services/transactionService.js";
import { recordAudit } from "../services/auditService.js";

const router = Router();
router.use(requireAuth, requireRole("admin", "operator", "viewer"));

const listSchema = z.object({
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

router.get("/", validateQuery(listSchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listSchema> }).validatedQuery;
  const rows = listTransactions(q);
  res.json({ transactions: rows.map(serializeTransaction) });
});

router.get("/export.csv", validateQuery(listSchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listSchema> }).validatedQuery;
  const rows = listTransactions({ ...q, limit: q.limit ?? 1000 });

  const header = [
    "id",
    "pump_id",
    "plate",
    "fuel_type",
    "amount_mode",
    "price_per_liter",
    "dispensed_liters",
    "total_amount",
    "payment_status",
    "status",
    "created_at",
    "completed_at",
  ];
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const t of rows) {
    lines.push(
      [
        t.id,
        t.pump_id,
        t.plate,
        t.fuel_type,
        t.amount_mode,
        t.price_per_liter,
        t.dispensed_liters,
        t.total_amount,
        t.payment_status,
        t.status,
        t.created_at,
        t.completed_at,
      ]
        .map(escape)
        .join(",")
    );
  }

  recordAudit({ user: req.user!, action: "transactions_exported", details: { count: rows.length }, ip: req.ip });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="islemler-${Date.now()}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

export { router as transactionsRouter };
