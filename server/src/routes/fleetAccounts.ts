import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  FleetError,
  addPlate,
  createAccount,
  listAccounts,
  listMovements,
  listPlates,
  removePlate,
  serializeAccountAdmin,
  serializeMovement,
  serializePlate,
  setAccountActive,
  topUp,
  updateContact,
} from "../services/fleetService.js";

const router = Router();
// Filo hesaplari yalnizca istasyon yoneticisine (admin) ve platform yoneticisine
// (super_admin) acik; operator/viewer goremez/duzenleyemez - kampanya kodlariyla ayni yetki seviyesi.
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected);

router.get("/", (req, res) => {
  const accounts = listAccounts(req.stationId!).map((a) => ({ ...serializeAccountAdmin(a), plates: listPlates(a.id).map(serializePlate) }));
  res.json({ accounts });
});

router.get("/:id/movements", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    const movements = listMovements(req.stationId!, id).map(serializeMovement);
    res.json({ movements });
  } catch (err) {
    if (err instanceof FleetError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const createSchema = z.object({
  companyName: z.string().trim().min(2, "Sirket adi en az 2 karakter olmalidir.").max(120),
  vkn: z.string().trim().max(20).optional(),
  billingType: z.enum(["prepaid", "postpaid"]),
  creditLimit: z.number().positive().max(10000000).optional(),
  contactEmail: z.string().trim().email("Gecerli bir e-posta girin.").max(200).optional(),
  contactPhone: z.string().trim().max(20).optional(),
  lowBalanceThreshold: z.number().positive().max(10000000).optional(),
});

router.post("/", csrfProtection, validateBody(createSchema), (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;
  const account = createAccount(req.stationId!, body, req.user!);
  recordAudit({
    user: req.user!,
    action: "fleet_account_created",
    entityType: "fleet_account",
    entityId: account.id,
    details: body,
    ip: req.ip,
    stationId: req.stationId,
  });
  res.status(201).json({ account: serializeAccountAdmin(account) });
});

const contactSchema = z.object({
  contactEmail: z.string().trim().email("Gecerli bir e-posta girin.").max(200).nullable().optional(),
  contactPhone: z.string().trim().max(20).nullable().optional(),
  lowBalanceThreshold: z.number().positive().max(10000000).nullable().optional(),
});

router.patch("/:id/contact", csrfProtection, validateBody(contactSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    const body = req.body as z.infer<typeof contactSchema>;
    const account = updateContact(req.stationId!, id, body);
    recordAudit({
      user: req.user!,
      action: "fleet_account_contact_updated",
      entityType: "fleet_account",
      entityId: id,
      details: body,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ account: serializeAccountAdmin(account) });
  } catch (err) {
    if (err instanceof FleetError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const activeSchema = z.object({ active: z.boolean() });

router.patch("/:id/active", csrfProtection, validateBody(activeSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    const { active } = req.body as z.infer<typeof activeSchema>;
    const account = setAccountActive(req.stationId!, id, active);
    recordAudit({
      user: req.user!,
      action: active ? "fleet_account_activated" : "fleet_account_deactivated",
      entityType: "fleet_account",
      entityId: id,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ account: serializeAccountAdmin(account) });
  } catch (err) {
    if (err instanceof FleetError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const plateSchema = z.object({ plate: z.string().trim().min(5).max(15) });

router.post("/:id/plates", csrfProtection, validateBody(plateSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    const { plate } = req.body as z.infer<typeof plateSchema>;
    const row = addPlate(req.stationId!, id, plate);
    recordAudit({ user: req.user!, action: "fleet_plate_added", entityType: "fleet_account", entityId: id, details: { plate }, ip: req.ip, stationId: req.stationId });
    res.status(201).json({ plate: serializePlate(row) });
  } catch (err) {
    if (err instanceof FleetError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.delete("/:id/plates/:plateId", csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  const plateId = Number(req.params.plateId);
  if (!Number.isInteger(id) || !Number.isInteger(plateId)) return void res.status(400).json({ error: "Gecersiz kimlik." });
  try {
    removePlate(req.stationId!, id, plateId);
    recordAudit({ user: req.user!, action: "fleet_plate_removed", entityType: "fleet_account", entityId: id, ip: req.ip, stationId: req.stationId });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof FleetError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const topUpSchema = z.object({ amount: z.number().positive().max(10000000), note: z.string().trim().max(300).optional() });

router.post("/:id/topup", csrfProtection, validateBody(topUpSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    const { amount, note } = req.body as z.infer<typeof topUpSchema>;
    const account = topUp(req.stationId!, id, amount, note, req.user!);
    recordAudit({
      user: req.user!,
      action: "fleet_account_topup",
      entityType: "fleet_account",
      entityId: id,
      details: { amount, note },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ account: serializeAccountAdmin(account) });
  } catch (err) {
    if (err instanceof FleetError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as fleetAccountsRouter };
