import { Router } from "express";
import { z } from "zod";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { tankerTrackingRateLimit } from "../middleware/rateLimit.js";
import { FuelOrderError, getTrackingInfo, updateTrackerLocation } from "../services/fuelOrderService.js";

/**
 * Tanker canli konum takibi - platformun ilk GIRISSIZ genel-aga acik yazma ucu.
 *
 * Personel oturumu YOK: bu, kamyonun icindeki soforun telefonundan acilan bir
 * linktir (bkz. fuelOrderService.sendTrackingLink). Guvenlik tamamen token'a
 * dayanir - kiosk_access_token ile AYNI desen (randomBytes(24) base64url,
 * safeCompare ile karsilastirma, suresi dolar) - ve her istek yalnizca KENDI
 * siparisinin satirini gorebilir/guncelleyebilir (istasyon geneli veri sizintisi
 * yok). Kaba kuvvet denemesini pahali kilmak icin ayrica rate-limit uygulanir.
 */
const router = Router();
router.use(tankerTrackingRateLimit);

const tokenQuerySchema = z.object({ token: z.string().min(1).max(200) });

router.get("/:orderId", validateQuery(tokenQuerySchema), (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId)) return void res.status(400).json({ error: "Gecersiz siparis." });
  const { token } = (req as unknown as { validatedQuery: z.infer<typeof tokenQuerySchema> }).validatedQuery;
  try {
    res.json({ tracking: getTrackingInfo(orderId, token) });
  } catch (err) {
    if (err instanceof FuelOrderError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const locationSchema = z.object({
  token: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

router.post("/:orderId/location", validateBody(locationSchema), (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId)) return void res.status(400).json({ error: "Gecersiz siparis." });
  const { token, lat, lng } = req.body as z.infer<typeof locationSchema>;
  try {
    updateTrackerLocation(orderId, token, lat, lng);
    res.status(204).end();
  } catch (err) {
    if (err instanceof FuelOrderError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as tankerTrackingRouter };
