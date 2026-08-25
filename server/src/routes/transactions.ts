import { Router } from "express";
import { z } from "zod";
import { attachStationScope, requireAuth, requireRole, requireStationSelected, csrfProtection } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { chargeAmount, getTransactionById, listTransactions, serializeTransaction, TransactionError } from "../services/transactionService.js";
import { recordAudit } from "../services/auditService.js";
import {
  RefundError,
  getRefundableInfo,
  listRefunds,
  refundTransaction,
  refundedTotalsFor,
  serializeRefund,
} from "../services/refundService.js";
import { createInvoice, InvoiceError } from "../services/invoiceService.js";
import { getInvoiceForTransaction, recordInvoiceFailure, recordInvoiceSuccess, serializeInvoice } from "../services/invoiceRecordService.js";

const router = Router();
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin", "operator", "viewer"), attachStationScope, requireStationSelected);

const listSchema = z.object({
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

router.get("/", validateQuery(listSchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listSchema> }).validatedQuery;
  const rows = listTransactions(req.stationId!, q);
  // Iade ozeti listeyle birlikte gelir: aksi halde ekran her satir icin ayri istek atardi.
  const refunded = refundedTotalsFor(rows.map((t) => t.id));
  res.json({
    transactions: rows.map((t) => ({ ...serializeTransaction(t), refundedAmount: refunded.get(t.id) ?? 0 })),
  });
});

router.get("/export.csv", validateQuery(listSchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listSchema> }).validatedQuery;
  const rows = listTransactions(req.stationId!, { ...q, limit: q.limit ?? 1000 });
  // Mutabakat iadeleri kasadan dusuyor; ciro dokumu onlari gostermezse iki rapor
  // birbiriyle celisir ve fark aciklanamaz gorunur.
  const csvRefunded = refundedTotalsFor(rows.map((t) => t.id));

  const header = [
    "id",
    "pump_id",
    "plate",
    "fuel_type",
    "amount_mode",
    "price_per_liter",
    "dispensed_liters",
    "total_amount",
    "discount_code",
    "discount_amount",
    "charge_amount",
    "refunded_amount",
    "loyalty_points_redeemed",
    "loyalty_points_earned",
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
        t.discount_code,
        t.discount_amount,
        chargeAmount(t),
        csvRefunded.get(t.id) ?? 0,
        t.loyalty_points_redeemed,
        t.loyalty_points_earned,
        t.payment_status,
        t.status,
        t.created_at,
        t.completed_at,
      ]
        .map(escape)
        .join(",")
    );
  }

  recordAudit({ user: req.user!, action: "transactions_exported", details: { count: rows.length }, ip: req.ip, stationId: req.stationId });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="islemler-${Date.now()}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

router.get("/:id/invoice", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz islem." });
  try {
    const t = getTransactionById(id, req.stationId!);
    const invoice = getInvoiceForTransaction(t.id);
    res.json({ invoice: invoice ? serializeInvoice(invoice) : null });
  } catch (err) {
    if (err instanceof TransactionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post("/:id/invoice", requireRole("super_admin", "tenant_admin", "admin", "operator"), csrfProtection, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz islem." });
  let t;
  try {
    t = getTransactionById(id, req.stationId!);
  } catch (err) {
    if (err instanceof TransactionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
  try {
    const result = await createInvoice(t);
    const invoice = recordInvoiceSuccess(t.station_id, t.id, result.providerInvoiceId, req.user!);
    recordAudit({
      user: req.user!,
      action: "invoice_created",
      entityType: "transaction",
      entityId: String(t.id),
      details: { providerInvoiceId: result.providerInvoiceId },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ invoice: serializeInvoice(invoice) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fatura olusturulamadi.";
    const status = err instanceof InvoiceError ? err.status : 502;
    recordInvoiceFailure(t.station_id, t.id, message, req.user!);
    recordAudit({
      user: req.user!,
      action: "invoice_failed",
      entityType: "transaction",
      entityId: String(t.id),
      details: { error: message },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(status).json({ error: message });
  }
});

// --- Iade (refund) ----------------------------------------------------------
// Para disari cikan bir islem oldugu icin yalnizca yoneticiye acik; operator/viewer
// iade yapamaz.

router.get("/:id/refunds", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz islem kimligi." });
  try {
    res.json({
      refunds: listRefunds(req.stationId!, id).map(serializeRefund),
      // Onizleme ayni yanitta: "ne kadari iade edilebilir" sorusu ekranda durmali.
      info: getRefundableInfo(req.stationId!, id),
    });
  } catch (err) {
    if (err instanceof RefundError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const refundSchema = z.object({
  amount: z.number().positive().max(1000000).optional(),
  reason: z.string().trim().min(3, "Iade gerekcesi zorunludur.").max(300),
});

// csrfProtection bu router'da rota BASINA uygulaniyor (pumps.ts'teki gibi router
// genelinde degil); para disari cikaran bir uc icin atlanmasi kabul edilemez.
router.post(
  "/:id/refunds",
  requireRole("super_admin", "tenant_admin", "admin"),
  csrfProtection,
  validateBody(refundSchema),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz islem kimligi." });
    try {
      const body = req.body as z.infer<typeof refundSchema>;
      const refund = await refundTransaction(req.stationId!, id, { ...body, ip: req.ip }, req.user!);
      recordAudit({
        user: req.user!,
        action: "transaction_refunded",
        entityType: "transaction",
        entityId: id,
        details: { amount: refund.amount, reason: refund.reason, paymentMethod: refund.payment_method },
        ip: req.ip,
        stationId: req.stationId,
      });
      res.status(201).json({ refund: serializeRefund(refund), info: getRefundableInfo(req.stationId!, id) });
    } catch (err) {
      if (err instanceof RefundError) return void res.status(err.status).json({ error: err.message });
      throw err;
    }
  }
);

export { router as transactionsRouter };
