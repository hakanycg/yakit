import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  ACCOUNT_KINDS,
  CashAccountError,
  MOVEMENT_DIRECTIONS,
  createAccount,
  deleteMovement,
  listAccountsWithBalance,
  listMovementsPaged,
  recordMovement,
  serializeAccount,
  serializeMovement,
  updateAccount,
} from "../services/cashAccountService.js";
import { csvEscape } from "../utils/csv.js";

const router = Router();
// Mali veri: operator/viewer goremez - expenses.ts/supplierLedger.ts ile ayni gerekce.
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected);

const kindEnum = z.enum(ACCOUNT_KINDS);
const directionEnum = z.enum(MOVEMENT_DIRECTIONS);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.");

router.get("/", (req, res) => {
  res.json({ accounts: listAccountsWithBalance(req.stationId!) });
});

const createAccountSchema = z.object({
  name: z.string().trim().min(2, "Hesap adi en az 2 karakter olmalidir.").max(120),
  kind: kindEnum,
});

router.post("/", csrfProtection, validateBody(createAccountSchema), (req, res) => {
  try {
    const body = req.body as z.infer<typeof createAccountSchema>;
    const account = createAccount(req.stationId!, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "cash_account_created",
      entityType: "cash_account",
      entityId: account.id,
      details: { name: account.name, kind: account.kind },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ account: serializeAccount(account) });
  } catch (err) {
    if (err instanceof CashAccountError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const updateAccountSchema = z.object({ active: z.boolean() });

router.patch("/:id", csrfProtection, validateBody(updateAccountSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap." });
  try {
    const body = req.body as z.infer<typeof updateAccountSchema>;
    const account = updateAccount(req.stationId!, id, body);
    recordAudit({
      user: req.user!,
      action: "cash_account_updated",
      entityType: "cash_account",
      entityId: id,
      details: { active: account.active },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ account: serializeAccount(account) });
  } catch (err) {
    if (err instanceof CashAccountError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const movementsQuerySchema = z.object({
  accountId: z.coerce.number().int().positive().optional(),
  direction: directionEnum.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

router.get("/movements", validateQuery(movementsQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof movementsQuerySchema> }).validatedQuery;
  const result = listMovementsPaged(req.stationId!, q);
  res.json({
    movements: result.movements.map(serializeMovement),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
});

router.get("/movements/export.csv", validateQuery(movementsQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof movementsQuerySchema> }).validatedQuery;
  const rows = listMovementsPaged(req.stationId!, { ...q, pageSize: 200, page: 1 }).movements;

  const directionLabel: Record<string, string> = { in: "Giris", out: "Cikis" };
  const header = ["id", "hesap_id", "yon", "tutar", "tarih", "aciklama", "olusturulma"];
  const lines = [header.join(",")];
  for (const m of rows) {
    lines.push(
      [m.id, m.account_id, directionLabel[m.direction] ?? m.direction, m.amount, m.movement_date, m.description, m.created_at]
        .map(csvEscape)
        .join(",")
    );
  }

  recordAudit({
    user: req.user!,
    action: "cash_account_movements_exported",
    details: { count: rows.length },
    ip: req.ip,
    stationId: req.stationId,
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="kasa-banka-hareketleri-${Date.now()}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

const createMovementSchema = z.object({
  accountId: z.number().int().positive(),
  direction: directionEnum,
  amount: z.number().positive().max(10_000_000),
  movementDate: dateSchema,
  description: z.string().trim().max(300).optional(),
});

router.post("/movements", csrfProtection, validateBody(createMovementSchema), (req, res) => {
  try {
    const body = req.body as z.infer<typeof createMovementSchema>;
    const movement = recordMovement(req.stationId!, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "cash_account_movement_created",
      entityType: "cash_account_movement",
      entityId: movement.id,
      details: { accountId: movement.account_id, direction: movement.direction, amount: movement.amount },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ movement: serializeMovement(movement) });
  } catch (err) {
    if (err instanceof CashAccountError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.delete("/movements/:id", csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hareket." });
  try {
    deleteMovement(req.stationId!, id);
    recordAudit({
      user: req.user!,
      action: "cash_account_movement_deleted",
      entityType: "cash_account_movement",
      entityId: id,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof CashAccountError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as cashAccountsRouter };
