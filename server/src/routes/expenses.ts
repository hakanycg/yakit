import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  EXPENSE_CATEGORIES,
  ExpenseError,
  createExpense,
  deleteExpense,
  listExpensesPaged,
  serializeExpense,
  summarizeExpenses,
} from "../services/expenseService.js";
import { csvEscape } from "../utils/csv.js";

const router = Router();
// Mali veri: operator/viewer goremez - fuelStock.ts'teki ayni gerekce (super_admin
// requireRole icinde her zaman gectigi icin ayrica listelenmiyor).
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected);

const categoryEnum = z.enum(EXPENSE_CATEGORIES);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.");

const listQuerySchema = z.object({
  category: categoryEnum.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

router.get("/", validateQuery(listQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listQuerySchema> }).validatedQuery;
  const result = listExpensesPaged(req.stationId!, q);
  res.json({
    expenses: result.expenses.map(serializeExpense),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
});

const summaryQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

router.get("/summary", validateQuery(summaryQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof summaryQuerySchema> }).validatedQuery;
  res.json(summarizeExpenses(req.stationId!, q.from, q.to));
});

router.get("/export.csv", validateQuery(listQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listQuerySchema> }).validatedQuery;
  const rows = listExpensesPaged(req.stationId!, { ...q, pageSize: 200, page: 1 }).expenses;

  const categoryLabel: Record<string, string> = {
    elektrik: "Elektrik",
    su_dogalgaz: "Su/Dogalgaz",
    kira: "Kira",
    bakim_onarim: "Bakim/Onarim",
    personel_maasi: "Personel Maasi",
    sigorta: "Sigorta",
    vergi_harc: "Vergi/Harc",
    diger: "Diger",
  };
  const header = ["id", "kategori", "aciklama", "tutar", "tarih", "olusturulma"];
  const lines = [header.join(",")];
  for (const e of rows) {
    lines.push(
      [e.id, categoryLabel[e.category] ?? e.category, e.description, e.amount, e.expense_date, e.created_at].map(csvEscape).join(",")
    );
  }

  recordAudit({ user: req.user!, action: "expenses_exported", details: { count: rows.length }, ip: req.ip, stationId: req.stationId });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="genel-giderler-${Date.now()}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

const createSchema = z.object({
  category: categoryEnum,
  description: z.string().trim().max(300).optional(),
  amount: z.number().positive().max(10_000_000),
  expenseDate: dateSchema,
});

router.post("/", csrfProtection, validateBody(createSchema), (req, res) => {
  try {
    const body = req.body as z.infer<typeof createSchema>;
    const expense = createExpense(req.stationId!, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "expense_created",
      entityType: "expense",
      entityId: expense.id,
      details: { category: expense.category, amount: expense.amount },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ expense: serializeExpense(expense) });
  } catch (err) {
    if (err instanceof ExpenseError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.delete("/:id", csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz gider." });
  try {
    deleteExpense(req.stationId!, id);
    recordAudit({ user: req.user!, action: "expense_deleted", entityType: "expense", entityId: id, ip: req.ip, stationId: req.stationId });
    res.status(204).end();
  } catch (err) {
    if (err instanceof ExpenseError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as expensesRouter };
