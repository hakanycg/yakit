import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate.js";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { recordAudit } from "../services/auditService.js";
import { verifyTotpCode } from "../utils/totp.js";
import {
  ensureSyncToken,
  getStationBySyncToken,
  getSyncState,
  getStationCacheSnapshot,
  recordHeartbeat,
  recordSyncEvent,
  rotateSyncToken,
} from "../services/syncService.js";

const router = Router();

/**
 * Istasyon ajani bir kullanici oturumu acmaz (kiosk PC'sinde arka planda calisan
 * bir servis surecidir) - bu yuzden oturum/CSRF yerine istasyon basina uretilen
 * paylasilan bir sirla (X-Station-Sync-Token) kimlik dogrular. Token, admin/
 * super_admin tarafindan asagidaki /token ucundan alinip ajanin yapilandirmasina
 * girilir.
 */
function requireStationSyncToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.header("X-Station-Sync-Token");
  if (!token) {
    res.status(401).json({ error: "X-Station-Sync-Token basligi gerekli." });
    return;
  }
  const station = getStationBySyncToken(token);
  if (!station) {
    res.status(401).json({ error: "Gecersiz senkron token." });
    return;
  }
  req.stationId = station.id;
  next();
}

router.post("/heartbeat", requireStationSyncToken, (req, res) => {
  recordHeartbeat(req.stationId!);
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

router.get("/station-cache", requireStationSyncToken, (req, res) => {
  res.json(getStationCacheSnapshot(req.stationId!));
});

const eventsSchema = z.object({
  events: z
    .array(
      z.object({
        clientEventId: z.string().trim().min(1).max(100),
        eventType: z.string().trim().min(1).max(60),
        payload: z.unknown(),
      })
    )
    .min(1)
    .max(100),
});

router.post("/events", requireStationSyncToken, validateBody(eventsSchema), (req, res) => {
  const { events } = req.body as z.infer<typeof eventsSchema>;
  const results = events.map((e) => recordSyncEvent(req.stationId!, e));
  res.json({ results });
});

// Asagidaki uclar ise tam tersine bir yonetici oturumu gerektirir (token'i
// gormek/uretmek icin) - fleet-accounts route'uyla ayni yetki seviyesi.
router.get("/token", requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected, (req, res) => {
  const token = ensureSyncToken(req.stationId!);
  res.json({ syncToken: token });
});

const rotateTokenSchema = z.object({ code: z.string().trim().optional() });

// Ajan senkron token'i, ele gecirilirse istasyonun tum offline kuyruk/onbellek
// trafigini taklit etmeye yetecek kadar hassas bir sirdir - bu yuzden yeniden
// olusturma (eski token'i gecersiz kilan, geri alinamaz bir islem) icin, hesabinda
// 2FA acik olan kullanicilardan guncel bir TOTP kodu istenir (2FA'si olmayan
// hesaplar icin, sahip olmadiklari bir seyi zorunlu kilmak yerine mevcut oturum
// yeterli sayilir - tipki 2FA'nin kendisini kapatirken sifre istenmesi gibi).
router.post(
  "/token/rotate",
  requireAuth,
  requireRole("super_admin", "tenant_admin", "admin"),
  csrfProtection,
  attachStationScope,
  requireStationSelected,
  validateBody(rotateTokenSchema),
  (req, res) => {
    const user = req.user!;
    if (user.totp_enabled) {
      const { code } = req.body as z.infer<typeof rotateTokenSchema>;
      if (!code || !user.totp_secret || !verifyTotpCode(user.totp_secret, code)) {
        res.status(401).json({ error: "Gecerli bir dogrulama kodu gerekli.", requiresTotp: true });
        return;
      }
    }

    const token = rotateSyncToken(req.stationId!);
    recordAudit({
      user,
      action: "station_sync_token_rotated",
      entityType: "station",
      entityId: req.stationId!,
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ syncToken: token });
  }
);

router.get("/status", requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected, (req, res) => {
  const state = getSyncState(req.stationId!);
  res.json({
    lastHeartbeatAt: state?.last_heartbeat_at ?? null,
    lastSyncedAt: state?.last_synced_at ?? null,
    agentConfigured: state !== null,
  });
});

export { router as syncRouter };
