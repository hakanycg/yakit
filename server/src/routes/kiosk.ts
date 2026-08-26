import { Router } from "express";
import express from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate.js";
import { kioskRateLimit } from "../middleware/rateLimit.js";
import {
  TransactionError,
  cancelPendingTransaction,
  chargeAmount,
  createTransaction,
  finalizeTransactionPayment,
  getLastFuelTypeForPlate,
  getTransactionForIyzicoCallback,
  handleLatePaymentAfterCancellation,
  getTransactionForKiosk,
  markIyzicoPending,
  payWithFleetAccount,
  serializeTransaction,
} from "../services/transactionService.js";
import { listPumps, serializePump } from "../services/pumpService.js";
import { sendReceipt } from "../services/receiptService.js";
import { initializeCheckoutForm, retrieveCheckoutForm, IyzicoError } from "../services/iyzicoService.js";
import { isIyzicoReady } from "../services/paymentSettingsService.js";
import { getAvailableLiters } from "../services/fuelStockService.js";
import { getBalance as getLoyaltyBalance, getLoyaltyConfig } from "../services/loyaltyService.js";
import { DiscountError, validateCode } from "../services/discountService.js";
import { getAccountForPlate as getFleetAccountForPlate, serializeAccount as serializeFleetAccount } from "../services/fleetService.js";
import { env } from "../config.js";
import { db } from "../db/index.js";
import type { FuelPriceRow, FuelType, StationRow } from "../db/types.js";
import { logger } from "../utils/logger.js";
import { attachKioskDevice, requireKioskDevice } from "../middleware/kioskDevice.js";
import { normalizeStationCode } from "../utils/stationCode.js";
import { SUPPORT_CATEGORIES, SupportError, createSupportRequest, serializeSupportRequest } from "../services/supportService.js";

const router = Router();
router.use(kioskRateLimit);
// Token gonderildiyse dogrular ve istegi o kiosk'un istasyonuna baglar; zorunluluk
// kontrolu uc bazinda requireKioskDevice() ile yapilir (bkz. middleware/kioskDevice.ts).
router.use(attachKioskDevice);

const plateRegex = /^[A-Z0-9 ]{5,12}$/;

// Turkiye il plaka kodlari (01-81) - basit LPR simulasyonu icin gecerlilik kontrolu.
function isPlausiblePlate(plate: string): boolean {
  const normalized = plate.toUpperCase().replace(/\s+/g, "");
  const match = /^(\d{2})([A-Z]{1,3})(\d{2,4})$/.exec(normalized);
  if (!match) return false;
  const province = Number(match[1]);
  return province >= 1 && province <= 81;
}

/**
 * Kiosk acilis ucu. Adres parametresi hem YENI istasyon kodunu ("STM1234") hem de
 * ESKI slug'i ("merkez") kabul eder - boylece daha once dagitilmis kiosk adresleri
 * ve iyzico donus baglantilari calismaya devam eder.
 */
/**
 * Kiosk kalp atisi.
 *
 * Kiosk ekrani API'yi normalde YALNIZCA bir musteri kullanirken cagirir; gece boyu
 * musteri gelmeyen bir istasyonun kiosk'u bu yuzden "olu" gorunurdu. Bu uc, ekranin
 * acik ve merkeze baglanabilir oldugunu duzenli araliklarla bildirir; boylece
 * "kimse kullanmiyor" ile "cihaz cevrimdisi" birbirinden ayrisir.
 *
 * last_seen_at guncellemesi attachKioskDevice icinde yapilir; bu ucun tek isi
 * gecerli bir token'la duzenli olarak cagrilmis olmaktir.
 */
router.post("/heartbeat", (req, res) => {
  if (!req.kioskDevice) {
    return void res.status(401).json({ error: "Kiosk cihaz tokeni gerekiyor." });
  }
  res.status(204).end();
});

/**
 * Musteri destek talebi.
 *
 * Personelsiz istasyonda karti cekilip yakit akmayan bir musterinin baska hicbir yolu
 * yok. Talep, kritik alarma cevrilerek mevcut bildirim zincirine (e-posta/SMS) girer.
 *
 * Cihaz tokeni ZORUNLU: aksi halde bu uc, istasyon kimligini bilen herkesin nobetci
 * personele SMS yagdirabilecegi bir kanala donusurdu.
 */
const supportSchema = z.object({
  category: z.enum(SUPPORT_CATEGORIES),
  message: z.string().trim().max(500).optional(),
  contactPhone: z.string().trim().max(30).optional(),
  pumpId: z.number().int().positive().optional(),
  transactionId: z.number().int().positive().optional(),
});

router.post("/support", validateBody(supportSchema), (req, res) => {
  if (!req.kioskDevice || !req.kioskStation) {
    return void res.status(401).json({ error: "Kiosk cihaz tokeni gerekiyor." });
  }
  try {
    const body = req.body as z.infer<typeof supportSchema>;
    const { request, alarmRaised } = createSupportRequest({
      stationId: req.kioskStation.id,
      kioskId: req.kioskDevice.id,
      pumpId: body.pumpId ?? null,
      transactionId: body.transactionId ?? null,
      category: body.category,
      message: body.message ?? null,
      contactPhone: body.contactPhone ?? null,
    });
    res.status(201).json({ request: serializeSupportRequest(request), alarmRaised });
  } catch (err) {
    if (err instanceof SupportError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.get("/station/:slug", (req, res) => {
  const param = req.params.slug ?? "";
  const station =
    db.prepare<[string], StationRow>("SELECT * FROM stations WHERE code = ? AND active = 1").get(normalizeStationCode(param)) ??
    db.prepare<[string], StationRow>("SELECT * FROM stations WHERE slug = ? AND active = 1").get(param);
  if (!station) return void res.status(404).json({ error: "Istasyon bulunamadi." });
  if (!requireKioskDevice(req, res, station.id)) return;

  const prices = db.prepare<[number], FuelPriceRow>("SELECT * FROM fuel_prices WHERE station_id = ?").all(station.id);
  res.json({
    station: {
      id: station.id,
      slug: station.slug,
      code: station.code,
      name: station.name,
      address: station.address,
      latitude: station.latitude,
      longitude: station.longitude,
    },
    fuelPrices: prices.map((p) => ({
      fuelType: p.fuel_type,
      label: p.label,
      pricePerLiter: p.price_per_liter,
      inStock: getAvailableLiters(station.id, p.fuel_type) > 0,
    })),
    pumps: listPumps(station.id).map(serializePump),
    iyzicoEnabled: isIyzicoReady(station.id).ready,
    /**
     * Bu fiziksel kiosk tek bir pompanin basinda duruyorsa o pompanin kimligi.
     * Musteri zaten o pompanin onunde durdugu icin ona "hangi pompadasiniz?"
     * diye sormak hem gereksiz bir adim hem de yanlis pompayi secip baska bir
     * musterinin dolumunu baslatmasina acik kapi. Bagli kiosk yoksa (ör. ortak
     * bir odeme noktasi) null doner ve secim adimi eskisi gibi gosterilir.
     */
    boundPumpId: req.kioskDevice?.pump_id ?? null,
    // Istasyonun kendi iletisim numarasi: kiosk yardim ekraninda musteriye
    // aranacak numara olarak gosterilir.
    contactPhone: station.contact_phone ?? null,
  });
});

const lprSchema = z.object({ plate: z.string().min(5).max(15) });

router.post("/lpr/recognize", validateBody(lprSchema), (req, res) => {
  const { plate } = req.body as z.infer<typeof lprSchema>;
  const normalized = plate.toUpperCase().replace(/\s+/g, "");
  const plausible = isPlausiblePlate(normalized);
  // Gercek bir kamera/ANPR donanimi bu ortamda mevcut olmadigindan, plaka format
  // dogrulama + guven skoru simulasyonu ile plaka okuma sureci modellenir.
  res.json({
    plate: normalized,
    valid: plausible,
    confidence: plausible ? 0.9 + Math.random() * 0.09 : 0.2 + Math.random() * 0.3,
  });
});

const loyaltyBalanceSchema = z.object({ stationId: z.coerce.number().int().positive(), plate: z.string().min(1).max(15) });

router.get("/loyalty/balance", (req, res) => {
  const parsed = loyaltyBalanceSchema.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Gecersiz istek." });
  if (!requireKioskDevice(req, res, parsed.data.stationId)) return;
  const { enabled, pointValueTry } = getLoyaltyConfig(parsed.data.stationId);
  const points = enabled ? getLoyaltyBalance(parsed.data.stationId, parsed.data.plate) : 0;
  res.json({ enabled, points, valueTry: Math.round(points * pointValueTry * 100) / 100 });
});

router.get("/plate/last-fuel-type", (req, res) => {
  const parsed = loyaltyBalanceSchema.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Gecersiz istek." });
  if (!requireKioskDevice(req, res, parsed.data.stationId)) return;
  res.json({ fuelType: getLastFuelTypeForPlate(parsed.data.stationId, parsed.data.plate) });
});

const priceHistorySchema = z.object({
  stationId: z.coerce.number().int().positive(),
  fuelType: z.enum(["benzin", "motorin", "lpg"]),
  days: z.coerce.number().int().positive().max(365).optional(),
});

/** Fiyat seffafligi ekrani: musteriye son N gunun fiyat degisim gecmisini gosterir. */
router.get("/fuel-prices/history", (req, res) => {
  const parsed = priceHistorySchema.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Gecersiz istek." });
  if (!requireKioskDevice(req, res, parsed.data.stationId)) return;
  const cutoff = new Date(Date.now() - (parsed.data.days ?? 30) * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare<[number, string, string], { price_per_liter: number; created_at: string }>(
      `SELECT price_per_liter, created_at FROM fuel_price_history
       WHERE station_id = ? AND fuel_type = ? AND created_at >= ?
       ORDER BY created_at ASC`
    )
    .all(parsed.data.stationId, parsed.data.fuelType, cutoff);
  res.json({ history: rows.map((r) => ({ pricePerLiter: r.price_per_liter, changedAt: r.created_at })) });
});

/** Bosta-kalma ekraninda (attract mode) gosterilecek, o an aktif olan kampanyalarin herkese acik ozeti. */
router.get("/campaigns/active", (req, res) => {
  const stationId = z.coerce.number().int().positive().safeParse(req.query.stationId);
  if (!stationId.success) return void res.status(400).json({ error: "Gecersiz istek." });
  if (!requireKioskDevice(req, res, stationId.data)) return;
  const now = new Date().toISOString();
  const rows = db
    .prepare<[number, string, string], { code: string; type: "percent" | "fixed"; value: number; fuel_type: FuelType | null }>(
      `SELECT code, type, value, fuel_type FROM discount_codes
       WHERE station_id = ? AND active = 1
         AND (starts_at IS NULL OR starts_at <= ?)
         AND (expires_at IS NULL OR expires_at >= ?)
         AND (max_uses IS NULL OR used_count < max_uses)
       ORDER BY created_at DESC LIMIT 10`
    )
    .all(stationId.data, now, now);
  res.json({ campaigns: rows.map((r) => ({ code: r.code, type: r.type, value: r.value, fuelType: r.fuel_type })) });
});

const discountPreviewSchema = z.object({
  stationId: z.number().int().positive(),
  code: z.string().trim().min(1).max(30),
  fuelType: z.enum(["benzin", "motorin", "lpg"]),
  totalAmount: z.number().positive().max(1000000),
});

router.post("/discount/preview", validateBody(discountPreviewSchema), (req, res) => {
  const { stationId, code, fuelType, totalAmount } = req.body as z.infer<typeof discountPreviewSchema>;
  if (!requireKioskDevice(req, res, stationId)) return;
  try {
    const { discountAmount } = validateCode(stationId, code, fuelType as FuelType, totalAmount);
    res.json({ valid: true, discountAmount });
  } catch (err) {
    if (err instanceof DiscountError || err instanceof TransactionError) {
      res.status(err.status).json({ valid: false, error: err.message });
      return;
    }
    throw err;
  }
});

const createSchema = z.object({
  pumpId: z.number().int().positive(),
  plate: z.string().regex(plateRegex, "Gecersiz plaka formati."),
  plateSource: z.enum(["manual", "lpr"]).default("manual"),
  fuelType: z.enum(["benzin", "motorin", "lpg"]),
  amountMode: z.enum(["amount", "liters", "full_tank"]),
  requestedAmount: z.number().positive().max(50000).optional(),
  requestedLiters: z.number().positive().max(300).optional(),
  discountCode: z.string().trim().min(1).max(30).optional(),
  redeemPoints: z.number().positive().max(1000000).optional(),
});

router.post("/transactions", validateBody(createSchema), (req, res) => {
  // En kritik uc: islem baslatmak pompayi rezerve eder. Istek yalnizca `pumpId`
  // tasidigi icin, hangi istasyonun kuralinin uygulanacagi pompadan bulunur ve
  // cihaz tokeni o istasyona ait degilse istek reddedilir.
  const { pumpId } = req.body as z.infer<typeof createSchema>;
  const pump = db.prepare<[number], { station_id: number }>("SELECT station_id FROM pumps WHERE id = ?").get(pumpId);
  if (!pump) return void res.status(404).json({ error: "Pompa bulunamadi." });
  if (!requireKioskDevice(req, res, pump.station_id)) return;

  try {
    const { transaction, accessToken } = createTransaction(req.body as z.infer<typeof createSchema>);
    res.status(201).json({ transaction: serializeTransaction(transaction), accessToken });
  } catch (err) {
    if (err instanceof TransactionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

function requireAccessToken(req: import("express").Request, res: import("express").Response): string | null {
  const token = req.header("x-kiosk-token");
  if (!token) {
    res.status(401).json({ error: "Erisim tokeni eksik." });
    return null;
  }
  return token;
}

router.get("/transactions/:id", (req, res) => {
  const token = requireAccessToken(req, res);
  if (!token) return;
  try {
    const t = getTransactionForKiosk(Number(req.params.id), token);
    res.json({ transaction: serializeTransaction(t) });
  } catch (err) {
    if (err instanceof TransactionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.get("/fleet-account", (req, res) => {
  const parsed = loyaltyBalanceSchema.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Gecersiz istek." });
  if (!requireKioskDevice(req, res, parsed.data.stationId)) return;
  const account = getFleetAccountForPlate(parsed.data.stationId, parsed.data.plate);
  res.json({ account: account ? serializeFleetAccount(account) : null });
});

const payFleetSchema = z.object({
  fleetAccountId: z.number().int().positive(),
  /** Arac km sayaci - opsiyonel; girilmezse tuketim analizi o dolumu atlar. */
  odometerKm: z.number().int().min(0).max(10_000_000).optional(),
});

router.post("/transactions/:id/pay-fleet", validateBody(payFleetSchema), (req, res) => {
  const token = requireAccessToken(req, res);
  if (!token) return;
  try {
    const { fleetAccountId, odometerKm } = req.body as z.infer<typeof payFleetSchema>;
    const updated = payWithFleetAccount(Number(req.params.id), token, fleetAccountId, odometerKm);
    res.json({ transaction: serializeTransaction(updated) });
  } catch (err) {
    if (err instanceof TransactionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const FUEL_LABELS: Record<string, string> = {
  benzin: "Kursunsuz Benzin",
  motorin: "Motorin (Diesel)",
  lpg: "Otogaz LPG",
};

router.post("/transactions/:id/iyzico/init", async (req, res) => {
  const token = requireAccessToken(req, res);
  if (!token) return;
  const id = Number(req.params.id);
  try {
    const t = getTransactionForKiosk(id, token);
    if (t.status !== "created") {
      res.status(409).json({ error: "Bu islem icin odeme baslatilamaz." });
      return;
    }
    if (!env.PUBLIC_API_BASE_URL) {
      res.status(409).json({ error: "Sunucunun herkese acik adresi tanimlanmamis; iyzico odemesi baslatilamaz." });
      return;
    }

    const callbackUrl = `${env.PUBLIC_API_BASE_URL}/api/kiosk/transactions/${id}/iyzico/callback`;
    const result = await initializeCheckoutForm({
      stationId: t.station_id,
      transactionId: id,
      totalAmount: chargeAmount(t),
      plate: t.plate,
      fuelLabel: FUEL_LABELS[t.fuel_type] ?? t.fuel_type,
      ip: req.ip ?? "0.0.0.0",
      callbackUrl,
      // "Depoyu Doldur"da gercek tutar dolum bitmeden bilinemez: kart burada tahsil
      // edilmez, yalnizca (o an gosterilen tahmini ust sinir kadar) bloke edilir. Gercek
      // tahsilat, dolum bitip kesin tutar belli olunca settleIyzicoPreAuthIfNeeded() ile
      // yapilir (bkz. transactionService.ts).
      preAuth: t.amount_mode === "full_tank",
    });

    markIyzicoPending(id, token, result.token);
    res.json({
      checkoutFormContent: result.checkoutFormContent,
      paymentPageUrl: result.paymentPageUrl ?? null,
    });
  } catch (err) {
    if (err instanceof TransactionError || err instanceof IyzicoError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * iyzico'nun odeme sonrasi yonlendirdigi (musteri tarayicisi araciligiyla, sunucudan
 * sunucuya degil) genel erisimli endpoint. Kiosk erisim tokeni burada YOKTUR; bu
 * yuzden guven, iyzico'ya sunucu-sunucu "retrieve" sorgusu atip donen sonucu
 * dogrulamaktan (ve HMAC imza kontrolunden) gelir, callback body'sindeki degerlerden degil.
 */
router.post(
  "/transactions/:id/iyzico/callback",
  express.urlencoded({ extended: false, limit: "8kb" }),
  async (req, res) => {
    const id = Number(req.params.id);
    const token = typeof (req.body as Record<string, unknown> | undefined)?.token === "string" ? (req.body as Record<string, string>).token : null;

    function redirectToKiosk(status: "ok" | "fail") {
      const row = db
        .prepare<[number], { slug: string }>(
          "SELECT s.slug as slug FROM stations s JOIN transactions t ON t.station_id = s.id WHERE t.id = ?"
        )
        .get(id);
      const base = row ? `${env.WEB_ORIGIN}/kiosk/${row.slug}` : env.WEB_ORIGIN;
      res.redirect(303, `${base}?tx=${id}&iyzico=${status}`);
    }

    if (!Number.isInteger(id) || !token) {
      logger.warn({ id }, "iyzico callback: eksik parametre.");
      redirectToKiosk("fail");
      return;
    }

    let t;
    try {
      t = getTransactionForIyzicoCallback(id, token);
    } catch (err) {
      logger.warn({ id, err }, "iyzico callback: token eslesmedi.");
      redirectToKiosk("fail");
      return;
    }

    if (t.status !== "created") {
      // Callback tekrar gelmis olabilir (ör. sayfa yenileme); islem zaten sonuclanmis, idempotent yanit ver.
      const already = t.status === "authorized" || t.status === "dispensing" || t.status === "completed";
      if (already) {
        redirectToKiosk("ok");
        return;
      }
      // Islem "cancelled"/"failed" durumuna dusmus (zaman asimi veya musteri iptali) AMA
      // simdi gecerli bir token'la callback geldi - musteri iyzico'da odemeyi YINE DE
      // tamamlamis olabilir (bkz. handleLatePaymentAfterCancellation yorumu). Sessizce
      // "fail" donup gec gelen basarili bir odemeyi kaybetmemek icin iyzico'ya sorup
      // dogruluyoruz.
      try {
        const result = await retrieveCheckoutForm(t.station_id, token);
        if (result.success) await handleLatePaymentAfterCancellation(t, result.paymentId ?? null);
      } catch (err) {
        logger.error({ id, err }, "iyzico callback: gec gelen odeme kontrolu basarisiz.");
      }
      redirectToKiosk("fail");
      return;
    }

    try {
      const result = await retrieveCheckoutForm(t.station_id, token);
      // NOT: gercek iyzico sandbox testinde gorduk ki on-provizyon (pre-auth) ile baslatilan
      // checkout formlarinda iyzico conversationId'yi retrieve yanitinda BOS (null) dondurebiliyor
      // - odeme gercekten basarili olsa bile. Asil guvenlik garantisi zaten `token` uzerinden
      // geliyor: getTransactionForIyzicoCallback() bu token'in DOGRU islem kaydina ait oldugunu
      // (payment_reference eslesmesiyle) onceden dogruladi, ve retrieveCheckoutForm() de ayni
      // token'i iyzico'ya sunucu-sunucu sorgulayarak SADECE o token'a ait sonucu getiriyor -
      // yani conversationId olmadan da carpraz islem riski yok. Bu yuzden conversationId
      // yalnizca MEVCUTSA ve UYUSMUYORSA hata sayilir; hic donmemesi (null) engellenmez.
      if (result.conversationId && result.conversationId !== String(id)) {
        throw new IyzicoError("iyzico conversationId uyumsuz.", 502);
      }
      finalizeTransactionPayment(id, {
        success: result.success,
        reference: result.paymentId ?? token,
        message: result.message,
      });
      redirectToKiosk(result.success ? "ok" : "fail");
    } catch (err) {
      logger.error({ id, err }, "iyzico callback dogrulama hatasi.");
      finalizeTransactionPayment(id, {
        success: false,
        reference: token,
        message: "iyzico odeme dogrulamasi basarisiz oldu.",
      });
      redirectToKiosk("fail");
    }
  }
);

router.post("/transactions/:id/cancel", (req, res) => {
  const token = requireAccessToken(req, res);
  if (!token) return;
  try {
    const updated = cancelPendingTransaction(Number(req.params.id), token, "Musteri tarafindan iptal edildi.");
    res.json({ transaction: serializeTransaction(updated) });
  } catch (err) {
    if (err instanceof TransactionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const receiptSchema = z.object({
  email: z.string().email().max(120).optional(),
  phone: z
    .string()
    .regex(/^\+?[0-9 ]{10,16}$/, "Gecersiz telefon numarasi.")
    .optional(),
});

router.post("/transactions/:id/receipt", validateBody(receiptSchema), async (req, res) => {
  const token = requireAccessToken(req, res);
  if (!token) return;
  try {
    const result = await sendReceipt(Number(req.params.id), token, req.body as z.infer<typeof receiptSchema>);
    res.json({ result });
  } catch (err) {
    if (err instanceof TransactionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export { router as kioskRouter };
