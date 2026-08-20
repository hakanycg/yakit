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
  getTransactionForIyzicoCallback,
  getTransactionForKiosk,
  markIyzicoPending,
  payTransaction,
  serializeTransaction,
} from "../services/transactionService.js";
import { listPumps, serializePump } from "../services/pumpService.js";
import { sendReceipt } from "../services/receiptService.js";
import { initializeCheckoutForm, retrieveCheckoutForm, IyzicoError } from "../services/iyzicoService.js";
import { isIyzicoReady } from "../services/paymentSettingsService.js";
import { getAvailableLiters } from "../services/fuelStockService.js";
import { getBalance as getLoyaltyBalance, getLoyaltyConfig } from "../services/loyaltyService.js";
import { DiscountError, validateCode } from "../services/discountService.js";
import { env } from "../config.js";
import { db } from "../db/index.js";
import type { FuelPriceRow, FuelType, StationRow } from "../db/types.js";
import { logger } from "../utils/logger.js";

const router = Router();
router.use(kioskRateLimit);

const plateRegex = /^[A-Z0-9 ]{5,12}$/;

// Turkiye il plaka kodlari (01-81) - basit LPR simulasyonu icin gecerlilik kontrolu.
function isPlausiblePlate(plate: string): boolean {
  const normalized = plate.toUpperCase().replace(/\s+/g, "");
  const match = /^(\d{2})([A-Z]{1,3})(\d{2,4})$/.exec(normalized);
  if (!match) return false;
  const province = Number(match[1]);
  return province >= 1 && province <= 81;
}

router.get("/station/:slug", (req, res) => {
  const station = db.prepare<[string], StationRow>("SELECT * FROM stations WHERE slug = ? AND active = 1").get(req.params.slug ?? "");
  if (!station) return void res.status(404).json({ error: "Istasyon bulunamadi." });

  const prices = db.prepare<[number], FuelPriceRow>("SELECT * FROM fuel_prices WHERE station_id = ?").all(station.id);
  res.json({
    station: {
      id: station.id,
      slug: station.slug,
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

function getStationOrThrow(stationId: number): StationRow {
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ? AND active = 1").get(stationId);
  if (!station) throw new TransactionError("Istasyon bulunamadi.", 404);
  return station;
}

const loyaltyBalanceSchema = z.object({ stationId: z.coerce.number().int().positive(), plate: z.string().min(1).max(15) });

router.get("/loyalty/balance", (req, res) => {
  const parsed = loyaltyBalanceSchema.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Gecersiz istek." });
  try {
    getStationOrThrow(parsed.data.stationId);
  } catch {
    return void res.status(404).json({ error: "Istasyon bulunamadi." });
  }
  const { enabled, pointValueTry } = getLoyaltyConfig(parsed.data.stationId);
  const points = enabled ? getLoyaltyBalance(parsed.data.stationId, parsed.data.plate) : 0;
  res.json({ enabled, points, valueTry: Math.round(points * pointValueTry * 100) / 100 });
});

const discountPreviewSchema = z.object({
  stationId: z.number().int().positive(),
  code: z.string().trim().min(1).max(30),
  fuelType: z.enum(["benzin", "motorin", "lpg"]),
  totalAmount: z.number().positive().max(1000000),
});

router.post("/discount/preview", validateBody(discountPreviewSchema), (req, res) => {
  const { stationId, code, fuelType, totalAmount } = req.body as z.infer<typeof discountPreviewSchema>;
  try {
    getStationOrThrow(stationId);
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

const paySchema = z.object({
  cardNumber: z.string().regex(/^[\d ]{12,23}$/, "Gecersiz kart numarasi."),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2024).max(2100),
  cvv: z.string().regex(/^\d{3,4}$/, "Gecersiz CVV."),
  holderName: z.string().min(2).max(64),
});

router.post("/transactions/:id/pay", validateBody(paySchema), (req, res) => {
  const token = requireAccessToken(req, res);
  if (!token) return;
  try {
    const updated = payTransaction(Number(req.params.id), token, req.body as z.infer<typeof paySchema>);
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
      redirectToKiosk(already ? "ok" : "fail");
      return;
    }

    try {
      const result = await retrieveCheckoutForm(t.station_id, token);
      if (result.conversationId !== String(id)) {
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
