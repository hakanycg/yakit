import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  FleetError,
  addPlate,
  createAccount,
  getAccountById,
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
import {
  FleetPortalError,
  createOrLinkPortalUser,
  listPortalUsersForAccount,
  resetPortalUserPassword,
  setPortalUserActive,
  unlinkPortalUser,
} from "../services/fleetPortalService.js";
import {
  FleetInvoiceError,
  createPeriodInvoice,
  getInvoiceDraft,
  listFleetInvoices,
  retryFleetInvoice,
  serializeFleetInvoice,
} from "../services/fleetInvoiceService.js";

import { accountReceivable, stationAging } from "../services/fleetReceivableService.js";
import {
  TopupRequestError,
  approveRequest,
  listPendingForStation,
  rejectRequest,
  serializeRequest as serializeTopupRequest,
} from "../services/fleetTopupRequestService.js";

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
  paymentTermDays: z.number().int().min(1).max(365).optional(),
  overdueBlockDays: z.number().int().min(1).max(365).optional(),
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
  paymentTermDays: z.number().int().min(1).max(365).nullable().optional(),
  overdueBlockDays: z.number().int().min(1).max(365).nullable().optional(),
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

const plateSchema = z.object({
  plate: z.string().trim().min(5).max(15),
  expectedFuelType: z.enum(["benzin", "motorin", "lpg"]).nullable().optional(),
});

router.post("/:id/plates", csrfProtection, validateBody(plateSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    const { plate, expectedFuelType } = req.body as z.infer<typeof plateSchema>;
    const row = addPlate(req.stationId!, id, plate, expectedFuelType ?? null);
    recordAudit({ user: req.user!, action: "fleet_plate_added", entityType: "fleet_account", entityId: id, details: { plate, expectedFuelType }, ip: req.ip, stationId: req.stationId });
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

/**
 * Musterinin portalden actigi bakiye yukleme talepleri.
 *
 * Talep para tasimaz (bkz. fleetTopupRequestService.ts): bakiye ancak burada
 * onaylandiginda ve mevcut topUp() yoluyla artar. Onaydaki tutar talep edilen degil,
 * personelin FIILEN TAHSIL ETTIGI tutardir - musterinin beyani bir niyet bildirimidir,
 * kasaya giren para eksik havale ya da farkli bir tutar olabilir.
 */
/**
 * Alacak yaslandirma tablosu.
 *
 * Sadece faturali (postpaid) hesaplar: on odemeli hesapta bakiye bitince pompa zaten
 * durur, dolayisiyla "tahsil edilememis alacak" diye bir kavram olusmaz.
 */
router.get("/aging", (req, res) => {
  res.json({ accounts: stationAging(req.stationId!) });
});

router.get("/:id/receivable", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    res.json({ receivable: accountReceivable(getAccountById(req.stationId!, id)) });
  } catch (err) {
    if (err instanceof FleetError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.get("/topup-requests", (req, res) => {
  res.json({ requests: listPendingForStation(req.stationId!).map(serializeTopupRequest) });
});

const approveSchema = z.object({
  amount: z.number().positive().max(10000000),
  note: z.string().trim().max(300).optional(),
});

router.post("/topup-requests/:id/approve", csrfProtection, validateBody(approveSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "Gecersiz talep." });
  const body = req.body as z.infer<typeof approveSchema>;
  try {
    const { request, account } = approveRequest(id, req.stationId!, req.user!, body);
    recordAudit({
      user: req.user!,
      action: "fleet_topup_request_approved",
      entityType: "fleet_account",
      entityId: account.id,
      details: { requestId: id, requestedAmount: request.requested_amount, approvedAmount: body.amount },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ request: serializeTopupRequest(request), account: serializeAccountAdmin(account) });
  } catch (err) {
    if (err instanceof TopupRequestError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const rejectSchema = z.object({ note: z.string().trim().max(300).optional() });

router.post("/topup-requests/:id/reject", csrfProtection, validateBody(rejectSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "Gecersiz talep." });
  try {
    const request = rejectRequest(id, req.stationId!, req.user!, (req.body as z.infer<typeof rejectSchema>).note);
    recordAudit({
      user: req.user!,
      action: "fleet_topup_request_rejected",
      entityType: "fleet_account",
      entityId: request.fleet_account_id,
      details: { requestId: id, requestedAmount: request.requested_amount },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ request: serializeTopupRequest(request) });
  } catch (err) {
    if (err instanceof TopupRequestError) return void res.status(err.status).json({ error: err.message });
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

// ---------------------------------------------------------------------------
// Filo musteri portali kullanicilari (bkz. services/fleetPortalService.ts)
//
// Sirket yetkilisine portal erisimi vermek, bakiye yuklemekle ayni yetki seviyesindedir:
// bu router'in basindaki requireRole zaten operator/viewer'i disarida birakiyor.
// ---------------------------------------------------------------------------

function handlePortalError(err: unknown, res: Response): boolean {
  if (err instanceof FleetPortalError || err instanceof FleetError || err instanceof FleetInvoiceError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

router.get("/:id/portal-users", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    res.json({ portalUsers: listPortalUsersForAccount(req.stationId!, id) });
  } catch (err) {
    if (!handlePortalError(err, res)) throw err;
  }
});

const portalUserSchema = z.object({
  email: z.string().trim().email("Gecerli bir e-posta girin.").max(160),
  displayName: z.string().trim().max(120).optional(),
});

router.post("/:id/portal-users", csrfProtection, validateBody(portalUserSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    const body = req.body as z.infer<typeof portalUserSchema>;
    const created = createOrLinkPortalUser(req.stationId!, id, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "fleet_portal_user_created",
      entityType: "fleet_account",
      entityId: id,
      // Gecici sifre denetim izine YAZILMAZ: audit_log'u okuyabilen herkes o hesaba
      // girebilir hale gelirdi.
      details: { email: body.email, linkedExisting: created.temporaryPassword === "" },
      ip: req.ip,
      stationId: req.stationId,
    });
    // Gecici sifre yalnizca BU yanitla, bir kez dondurulur; hicbir yerde saklanmaz.
    res.status(201).json({ portalUser: created.user, temporaryPassword: created.temporaryPassword || null });
  } catch (err) {
    if (!handlePortalError(err, res)) throw err;
  }
});

router.post("/:id/portal-users/:portalUserId/reset-password", csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  const portalUserId = Number(req.params.portalUserId);
  if (!Number.isInteger(id) || !Number.isInteger(portalUserId)) return void res.status(400).json({ error: "Gecersiz kimlik." });
  try {
    const temporaryPassword = resetPortalUserPassword(req.stationId!, id, portalUserId);
    recordAudit({
      user: req.user!,
      action: "fleet_portal_user_password_reset",
      entityType: "fleet_account",
      entityId: id,
      details: { portalUserId },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ temporaryPassword });
  } catch (err) {
    if (!handlePortalError(err, res)) throw err;
  }
});

const portalUserActiveSchema = z.object({ active: z.boolean() });

router.patch("/:id/portal-users/:portalUserId", csrfProtection, validateBody(portalUserActiveSchema), (req, res) => {
  const id = Number(req.params.id);
  const portalUserId = Number(req.params.portalUserId);
  if (!Number.isInteger(id) || !Number.isInteger(portalUserId)) return void res.status(400).json({ error: "Gecersiz kimlik." });
  try {
    const { active } = req.body as z.infer<typeof portalUserActiveSchema>;
    const portalUser = setPortalUserActive(req.stationId!, id, portalUserId, active);
    recordAudit({
      user: req.user!,
      action: active ? "fleet_portal_user_enabled" : "fleet_portal_user_disabled",
      entityType: "fleet_account",
      entityId: id,
      details: { portalUserId },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ portalUser });
  } catch (err) {
    if (!handlePortalError(err, res)) throw err;
  }
});

router.delete("/:id/portal-users/:portalUserId", csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  const portalUserId = Number(req.params.portalUserId);
  if (!Number.isInteger(id) || !Number.isInteger(portalUserId)) return void res.status(400).json({ error: "Gecersiz kimlik." });
  try {
    unlinkPortalUser(req.stationId!, id, portalUserId);
    recordAudit({
      user: req.user!,
      action: "fleet_portal_user_removed",
      entityType: "fleet_account",
      entityId: id,
      details: { portalUserId },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ ok: true });
  } catch (err) {
    if (!handlePortalError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------------
// Filo donem (icmal) faturasi (bkz. services/fleetInvoiceService.ts)
// ---------------------------------------------------------------------------

router.get("/:id/invoices", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    res.json({
      invoices: listFleetInvoices(req.stationId!, id).map(serializeFleetInvoice),
      // Onizleme ayni yanitta: personel "neyi imzalayacagim" sorusunu ayri bir istek
      // atmadan gorur ve ekran iki cagri arasinda tutarsiz kalmaz.
      draft: getInvoiceDraft(req.stationId!, id),
    });
  } catch (err) {
    if (!handlePortalError(err, res)) throw err;
  }
});

router.post("/:id/invoices", csrfProtection, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz hesap kimligi." });
  try {
    const invoice = await createPeriodInvoice(req.stationId!, id, req.user!);
    recordAudit({
      user: req.user!,
      action: "fleet_period_invoice_created",
      entityType: "fleet_account",
      entityId: id,
      details: { invoiceId: invoice.id, status: invoice.status, payableAmount: invoice.payable_amount },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ invoice: serializeFleetInvoice(invoice) });
  } catch (err) {
    if (!handlePortalError(err, res)) throw err;
  }
});

router.post("/:id/invoices/:invoiceId/retry", csrfProtection, async (req, res) => {
  const id = Number(req.params.id);
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isInteger(id) || !Number.isInteger(invoiceId)) return void res.status(400).json({ error: "Gecersiz kimlik." });
  try {
    const invoice = await retryFleetInvoice(req.stationId!, id, invoiceId);
    recordAudit({
      user: req.user!,
      action: "fleet_period_invoice_retried",
      entityType: "fleet_account",
      entityId: id,
      details: { invoiceId, status: invoice.status },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ invoice: serializeFleetInvoice(invoice) });
  } catch (err) {
    if (!handlePortalError(err, res)) throw err;
  }
});

export { router as fleetAccountsRouter };
