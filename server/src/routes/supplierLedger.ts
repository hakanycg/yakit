import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  SupplierLedgerError,
  deletePayment,
  getSupplierLedger,
  listPaymentsPaged,
  recordPayment,
  serializePayment,
} from "../services/supplierLedgerService.js";
import { csvEscape } from "../utils/csv.js";

const router = Router();
// Mali veri: operator/viewer goremez - fuelStock.ts/expenses.ts ile ayni gerekce.
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.");

router.get("/", (req, res) => {
  res.json({ ledger: getSupplierLedger(req.stationId!) });
});

const paymentsQuerySchema = z.object({
  supplierId: z.coerce.number().int().positive().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

router.get("/payments", validateQuery(paymentsQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof paymentsQuerySchema> }).validatedQuery;
  const result = listPaymentsPaged(req.stationId!, q);
  res.json({
    payments: result.payments.map(serializePayment),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
});

router.get("/payments/export.csv", validateQuery(paymentsQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof paymentsQuerySchema> }).validatedQuery;
  const rows = listPaymentsPaged(req.stationId!, { ...q, pageSize: 200, page: 1 }).payments;

  const header = ["id", "tedarikci_id", "tutar", "tarih", "not", "olusturulma"];
  const lines = [header.join(",")];
  for (const p of rows) {
    lines.push([p.id, p.supplier_id, p.amount, p.payment_date, p.note, p.created_at].map(csvEscape).join(","));
  }

  recordAudit({ user: req.user!, action: "supplier_payments_exported", details: { count: rows.length }, ip: req.ip, stationId: req.stationId });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="tedarikci-odemeleri-${Date.now()}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

const createSchema = z.object({
  supplierId: z.number().int().positive(),
  amount: z.number().positive().max(10_000_000),
  paymentDate: dateSchema,
  note: z.string().trim().max(300).optional(),
});

router.post("/payments", csrfProtection, validateBody(createSchema), (req, res) => {
  try {
    const body = req.body as z.infer<typeof createSchema>;
    const payment = recordPayment(req.stationId!, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "supplier_payment_created",
      entityType: "supplier_payment",
      entityId: payment.id,
      details: { supplierId: payment.supplier_id, amount: payment.amount },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ payment: serializePayment(payment) });
  } catch (err) {
    if (err instanceof SupplierLedgerError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.delete("/payments/:id", csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz odeme." });
  try {
    deletePayment(req.stationId!, id);
    recordAudit({
      user: req.user!,
      action: "supplier_payment_deleted",
      entityType: "supplier_payment",
      entityId: id,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof SupplierLedgerError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as supplierLedgerRouter };
