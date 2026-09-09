import { Router } from "express";
import { z } from "zod";
import { csrfProtection, requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { registerDeviceToken, unregisterDeviceToken } from "../services/pushNotificationService.js";

/**
 * Mobil kabuktaki (bkz. web mobil paketi) push bildirim cihaz token kaydi - istasyon
 * kapsamli DEGIL, dogrudan kullaniciya baglidir (bir kullanicinin birden fazla cihazi
 * olabilir). requireRole yok: herhangi bir oturum acmis kullanici KENDI cihaz tokenini
 * kaydedebilir/silebilir - kritik alarm bildirimi zaten yalnizca admin/operator rolune
 * gonderiliyor (bkz. alarmService.ts notifyCriticalAlarm), rol filtresi orada uygulanir.
 */

const router = Router();
router.use(requireAuth, csrfProtection);

const tokenSchema = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(["ios", "android", "web"]).optional(),
});

router.post("/", validateBody(tokenSchema), (req, res) => {
  const body = req.body as z.infer<typeof tokenSchema>;
  registerDeviceToken(req.user!.id, body.token, body.platform ?? "unknown");
  res.status(204).end();
});

const unregisterSchema = z.object({ token: z.string().min(20).max(4096) });

router.delete("/", validateBody(unregisterSchema), (req, res) => {
  const body = req.body as z.infer<typeof unregisterSchema>;
  unregisterDeviceToken(req.user!.id, body.token);
  res.status(204).end();
});

export { router as pushTokensRouter };
