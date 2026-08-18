import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate.js";
import { kioskRateLimit } from "../middleware/rateLimit.js";
import {
  TransactionError,
  cancelPendingTransaction,
  createTransaction,
  getTransactionForKiosk,
  payTransaction,
  serializeTransaction,
} from "../services/transactionService.js";
import { listPumps, serializePump } from "../services/pumpService.js";
import { db } from "../db/index.js";
import type { FuelPriceRow, StationRow } from "../db/types.js";

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
    fuelPrices: prices.map((p) => ({ fuelType: p.fuel_type, label: p.label, pricePerLiter: p.price_per_liter })),
    pumps: listPumps(station.id).map(serializePump),
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

const createSchema = z.object({
  pumpId: z.number().int().positive(),
  plate: z.string().regex(plateRegex, "Gecersiz plaka formati."),
  plateSource: z.enum(["manual", "lpr"]).default("manual"),
  fuelType: z.enum(["benzin", "motorin", "lpg"]),
  amountMode: z.enum(["amount", "liters", "full_tank"]),
  requestedAmount: z.number().positive().max(50000).optional(),
  requestedLiters: z.number().positive().max(300).optional(),
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

export { router as kioskRouter };
