import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  kioskStatus,
  listKioskFleet,
  serializeKioskFleetRow,
  summarizeKioskFleet,
} from "../services/kioskFleetService.js";
import { csvEscape } from "../utils/csv.js";

/**
 * Kiosk filosu - istasyonlar arasi saglik gorunumu.
 *
 * attachStationScope'un ?stationId= kapisindan gecmez (tek bir istasyona degil "tum
 * kiosk'larim"a bakar), bu yuzden kiraci filtresini kendisi uygular: platform yoneticisi
 * hepsini gorur, dagitim sirketi yoneticisi yalnizca kendi istasyonlarini.
 */
const router = Router();
router.use(requireAuth, requireRole("super_admin", "tenant_admin"));

const querySchema = z.object({
  status: z.enum(["online", "offline", "never_seen"]).optional(),
  q: z.string().trim().max(120).optional(),
});

router.get("/", validateQuery(querySchema), (req, res) => {
  const { status, q } = (req as unknown as { validatedQuery: z.infer<typeof querySchema> }).validatedQuery;
  const all = listKioskFleet(req.user!.tenant_id);

  // Ozet HER ZAMAN filtrelenmemis listeden hesaplanir: "3 cevrimdisi" rakami,
  // kullanici listeyi daraltinca degisirse gosterge olmaktan cikardi.
  const summary = summarizeKioskFleet(all);

  let rows = all;
  if (status) rows = rows.filter((k) => kioskStatus(k.last_seen_at) === status);
  if (q) {
    const needle = q.toLocaleLowerCase("tr");
    rows = rows.filter((k) =>
      [k.label, k.station_name, k.station_code, k.anydesk_id]
        .some((field) => field?.toLocaleLowerCase("tr").includes(needle))
    );
  }

  res.json({ kiosks: rows.map(serializeKioskFleetRow), summary });
});

router.get("/export.csv", (req, res) => {
  const rows = listKioskFleet(req.user!.tenant_id).map(serializeKioskFleetRow);
  const statusLabel: Record<string, string> = {
    online: "Cevrimici",
    offline: "Cevrimdisi",
    never_seen: "Hic baglanmadi",
  };
  const header = ["kiosk_id", "etiket", "istasyon", "istasyon_kodu", "durum", "cevrimdisi_dakika", "anydesk_id", "son_baglanti"];
  const lines = [header.join(",")];
  for (const k of rows) {
    lines.push(
      [k.id, k.label, k.stationName, k.stationCode, statusLabel[k.status], k.offlineMinutes, k.anydeskId, k.lastSeenAt]
        .map(csvEscape)
        .join(",")
    );
  }

  recordAudit({ user: req.user!, action: "kiosk_fleet_exported", details: { count: rows.length }, ip: req.ip, stationId: null });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="kiosk-filosu-${Date.now()}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

export const kioskFleetRouter = router;
