import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { loginRateLimit } from "../middleware/rateLimit.js";
import {
  clearFleetPortalCookies,
  fleetPortalCsrfProtection,
  requireFleetPortalAuth,
  setFleetPortalCookies,
} from "../middleware/fleetPortalAuth.js";
import {
  FleetPortalError,
  assertAccountAccess,
  authenticatePortalUser,
  changePortalPassword,
  createPortalSession,
  destroyPortalSession,
  getPlateBreakdown,
  getStatement,
  listAccountsForPortalUser,
} from "../services/fleetPortalService.js";
import { listPlates, serializePlate } from "../services/fleetService.js";
import { listInvoicesForAccount, serializeFleetInvoice } from "../services/fleetInvoiceService.js";
import { recordAudit } from "../services/auditService.js";
import {
  TopupRequestError,
  accountForVerifiedAccess,
  cancelOwnRequest,
  createRequest,
  listRequestsForAccount,
  serializeRequest,
} from "../services/fleetTopupRequestService.js";
import { getConsumptionReport } from "../services/fleetConsumptionService.js";
import { businessDateDaysAgo, currentBusinessDate } from "../utils/businessDay.js";

/**
 * Filo musteri portali - istasyon personeline DEGIL, filo musterisine acik uclar.
 *
 * Bu router requireAuth kullanmaz: buradaki kimlik personel oturumu degildir
 * (bkz. middleware/fleetPortalAuth.ts). Erisim kapsami tek bir yerde belirlenir -
 * assertAccountAccess - ve hesap kimligi alan HER uc oradan gecer.
 *
 * Portal PARA HAREKETI YAPMAZ. Musteri bakiye yukleme TALEBI acabilir (bir mesaj),
 * ama bakiyeyi yalnizca istasyon personeli, parayi fiilen tahsil ettikten sonra
 * panelden onaylayarak artirir - bkz. services/fleetTopupRequestService.ts.
 */
const router = Router();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.");
const rangeSchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  plate: z.string().max(32).optional(),
  type: z.enum(["topup", "charge", "refund", "adjustment"]).optional(),
});

function resolveRange(q: { from?: string; to?: string }): { from: string; to: string } {
  const to = q.to ?? currentBusinessDate();
  const from = q.from ?? businessDateDaysAgo(29);
  return from > to ? { from: to, to: from } : { from, to };
}

function query<T extends z.ZodTypeAny>(req: unknown): z.infer<T> {
  return (req as { validatedQuery: z.infer<T> }).validatedQuery;
}

// --- Giris / oturum ---------------------------------------------------------

const loginSchema = z.object({
  email: z.string().min(3).max(160),
  password: z.string().min(1).max(256),
});

router.post("/login", loginRateLimit, validateBody(loginSchema), (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const outcome = authenticatePortalUser(email, password);

  if (!outcome.ok || !outcome.user) {
    recordAudit({
      user: null,
      actorType: "anonymous",
      actorLabel: email.trim().toLowerCase(),
      action: "fleet_portal_login_failed",
      details: { email: email.trim().toLowerCase() },
      ip: req.ip,
      stationId: null,
    });
    res.status(outcome.status ?? 401).json({ error: outcome.error });
    return;
  }

  const session = createPortalSession(outcome.user.id, req.ip, req.header("user-agent"));
  setFleetPortalCookies(res, session.token, session.csrfToken);
  recordAudit({
    user: null,
    actorType: "fleet_portal",
    actorLabel: outcome.user.email,
    action: "fleet_portal_login",
    entityType: "fleet_portal_user",
    entityId: outcome.user.id,
    details: { email: outcome.user.email },
    ip: req.ip,
    stationId: null,
  });

  res.json({
    user: {
      id: outcome.user.id,
      email: outcome.user.email,
      displayName: outcome.user.display_name,
      mustChangePassword: !!outcome.user.must_change_password,
    },
    accounts: listAccountsForPortalUser(outcome.user.id),
  });
});

// requireFleetPortalAuth + fleetPortalCsrfProtection burada asagidaki router.use'dan
// once, rotaya ozel olarak veriliyor - /login gibi bu router.use'un disinda kalmasin
// diye (staff tarafinda auth.ts'teki /logout ile ayni desen). Cift gonderim CSRF
// kontrolu olmadan bir oturumu disaridan (baska bir siteden) zorla kapatmak
// engellenemezdi; SameSite=Strict cerezler bunu buyuk olcude zaten onluyor olsa da
// bu uc de artik ayni korumayi diger tum mutasyonlarla tutarli sekilde tasiyor.
router.post("/logout", requireFleetPortalAuth, fleetPortalCsrfProtection, (req, res) => {
  if (req.fleetPortalToken) destroyPortalSession(req.fleetPortalToken);
  clearFleetPortalCookies(res);
  res.json({ ok: true });
});

router.use(requireFleetPortalAuth, fleetPortalCsrfProtection);

router.get("/me", (req, res) => {
  const u = req.fleetPortalUser!;
  res.json({
    user: { id: u.id, email: u.email, displayName: u.display_name, mustChangePassword: !!u.must_change_password },
    accounts: listAccountsForPortalUser(u.id),
  });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

router.post("/password", validateBody(passwordSchema), (req, res) => {
  const { currentPassword, newPassword } = req.body as z.infer<typeof passwordSchema>;
  changePortalPassword(req.fleetPortalUser!.id, currentPassword, newPassword);
  // Sifre degisiminde tum oturumlar dusuruldu (mevcut oturum dahil): tarayicidaki
  // cerezi de temizlemezsek kullanici "giris yapmis ama her istekte 401" durumunda kalir.
  clearFleetPortalCookies(res);
  recordAudit({
    user: null,
    actorType: "fleet_portal",
    actorLabel: req.fleetPortalUser!.email,
    action: "fleet_portal_password_changed",
    entityType: "fleet_portal_user",
    entityId: req.fleetPortalUser!.id,
    ip: req.ip,
    stationId: null,
  });
  res.json({ ok: true });
});

// --- Hesap verileri ---------------------------------------------------------

router.get("/accounts", (req, res) => {
  res.json({ accounts: listAccountsForPortalUser(req.fleetPortalUser!.id) });
});

/** Hesap kimligi alan her ucun ortak kapisi. */
function accountIdFrom(req: { params: { id?: string } }, portalUserId: number): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new FleetPortalError("Hesap bulunamadi.", 404);
  assertAccountAccess(portalUserId, id);
  return id;
}

router.get("/accounts/:id/statement", validateQuery(rangeSchema), (req, res) => {
  const accountId = accountIdFrom(req, req.fleetPortalUser!.id);
  const q = query<typeof rangeSchema>(req);
  const { from, to } = resolveRange(q);
  res.json({ statement: getStatement(accountId, from, to, { plate: q.plate, type: q.type }) });
});

router.get("/accounts/:id/plates", (req, res) => {
  const accountId = accountIdFrom(req, req.fleetPortalUser!.id);
  res.json({ plates: listPlates(accountId).map(serializePlate) });
});

/**
 * Musteri kendi donem faturalarini gorur - "fatura geldi mi?" sorusunun cevabi icin
 * istasyonu aramasi gerekmesin. Yalnizca GONDERILMIS faturalar listelenir: henuz
 * kesilmemis (pending) veya saglayiciya ulasmamis (failed) bir belge musteri icin
 * mevcut degildir, gostermek "faturam var ama gelmemis" karisikligi yaratirdi.
 */
router.get("/accounts/:id/invoices", (req, res) => {
  const accountId = accountIdFrom(req, req.fleetPortalUser!.id);
  const invoices = listInvoicesForAccount(accountId)
    .filter((i) => i.status === "sent")
    .map(serializeFleetInvoice)
    // Saglayici hata mesaji musteriyi ilgilendirmez (ve ic ayrinti sizdirabilir).
    .map(({ errorMessage: _errorMessage, ...rest }) => rest);
  res.json({ invoices });
});

/**
 * Bakiye yukleme TALEBI.
 *
 * Portal salt okunur olmaya devam ediyor: bu uc para tasimaz, bakiyeye dokunmaz.
 * Yaptigi tek sey nobetci personele "su hesap su kadar yukleme istiyor" demek -
 * boylece bakiyesi biten sofor gece 2'de istasyonu telefonla aramak zorunda kalmaz.
 * Bakiye ancak personel panelden onaylayinca artar.
 */
const topupRequestSchema = z.object({
  amount: z.number().positive().max(10000000),
  note: z.string().trim().max(300).optional(),
});

router.post("/accounts/:id/topup-requests", validateBody(topupRequestSchema), (req, res) => {
  const accountId = accountIdFrom(req, req.fleetPortalUser!.id);
  const body = req.body as z.infer<typeof topupRequestSchema>;
  try {
    // Erisim accountIdFrom -> assertAccountAccess ile zaten dogrulandi.
    const account = accountForVerifiedAccess(accountId);
    const request = createRequest(account, req.fleetPortalUser!, body.amount, body.note);
    recordAudit({
      user: null,
      actorType: "fleet_portal",
      actorLabel: req.fleetPortalUser!.email,
      action: "fleet_topup_requested",
      entityType: "fleet_account",
      entityId: accountId,
      details: { requestId: request.id, amount: body.amount },
      ip: req.ip,
      stationId: account.station_id,
    });
    res.status(201).json({ request: serializeRequest(request) });
  } catch (err) {
    if (err instanceof TopupRequestError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.get("/accounts/:id/topup-requests", (req, res) => {
  const accountId = accountIdFrom(req, req.fleetPortalUser!.id);
  res.json({ requests: listRequestsForAccount(accountId).map(serializeRequest) });
});

router.delete("/accounts/:id/topup-requests/:requestId", (req, res) => {
  const accountId = accountIdFrom(req, req.fleetPortalUser!.id);
  const requestId = Number(req.params.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return void res.status(400).json({ error: "Gecersiz talep." });
  }
  try {
    cancelOwnRequest(requestId, accountId);
    res.status(204).end();
  } catch (err) {
    if (err instanceof TopupRequestError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

/**
 * Arac basina yakit tuketimi (L/100km).
 *
 * "Hangi arac ne kadar aldi" ekstrede zaten var; buradaki soru "ne kadar YAKTI".
 * Fark, surucu kaynakli yakit kacaginin sakli oldugu yerdir.
 */
router.get("/accounts/:id/consumption", validateQuery(rangeSchema), (req, res) => {
  const accountId = accountIdFrom(req, req.fleetPortalUser!.id);
  const { from, to } = resolveRange(query<typeof rangeSchema>(req));
  res.json({ from, to, ...getConsumptionReport(accountId, from, to) });
});

router.get("/accounts/:id/plate-breakdown", validateQuery(rangeSchema), (req, res) => {
  const accountId = accountIdFrom(req, req.fleetPortalUser!.id);
  const { from, to } = resolveRange(query<typeof rangeSchema>(req));
  res.json({ from, to, plates: getPlateBreakdown(accountId, from, to) });
});

router.get("/accounts/:id/statement.csv", validateQuery(rangeSchema), (req, res) => {
  const accountId = accountIdFrom(req, req.fleetPortalUser!.id);
  const q = query<typeof rangeSchema>(req);
  const { from, to } = resolveRange(q);
  const statement = getStatement(accountId, from, to, { plate: q.plate, type: q.type });

  const typeLabel: Record<string, string> = {
    topup: "Bakiye yukleme",
    charge: "Yakit alimi",
    refund: "Iade",
    adjustment: "Duzeltme",
  };
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["tarih,tur,plaka,yakit,litre,birim_fiyat,tutar,bakiye_sonrasi,not"];
  for (const r of statement.rows) {
    lines.push(
      [r.createdAt, typeLabel[r.type] ?? r.type, r.plate, r.fuelType, r.liters, r.pricePerLiter, r.amount, r.balanceAfter, r.note]
        .map(escape)
        .join(",")
    );
  }

  recordAudit({
    user: null,
    actorType: "fleet_portal",
    actorLabel: req.fleetPortalUser!.email,
    action: "fleet_portal_statement_exported",
    entityType: "fleet_account",
    entityId: accountId,
    details: { from, to, rowCount: statement.rows.length, portalUserId: req.fleetPortalUser!.id },
    ip: req.ip,
    stationId: null,
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="filo-ekstre-${from}_${to}.csv"`);
  // BOM: Excel UTF-8'i aksi halde bozuk gosterir.
  res.send("﻿" + lines.join("\n"));
});

/**
 * Servis hatalarini kendi durum kodlariyla dondurur. Genel errorHandler her hatayi 500
 * yapar; "hesap bulunamadi" (404) veya "mevcut sifre hatali" (401) gibi kullanicinin
 * duzeltebilecegi durumlarin 500 gorunmesi hem yaniltici hem de gereksiz destek cagrisi.
 */
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof FleetPortalError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
});

export const fleetPortalRouter = router;
