import { Router, raw } from "express";
import { z } from "zod";
import { attachStationScope, requireAuth, requireRole, requireStationSelected, csrfProtection } from "../middleware/auth.js";
import { validateQuery, validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  CallRecordingError,
  getRecordingById,
  getRetentionDays,
  isCallRecordingEnabled,
  listRecordings,
  readRecordingFile,
  saveRecording,
  setRetentionDays,
} from "../services/callRecordingService.js";
import type { CallRecordingRow } from "../db/types.js";

/**
 * Interkom kaydi (bkz. callRecordingService.ts): gorevlinin tarayicisinin cagri
 * bitince yukledigi sifreli sesin YALNIZCA yonetim rolleri (super_admin/tenant_admin/
 * admin) tarafindan LISTELENIP DINLENEBILECEGI, denetim-loglu uc.
 */

const ADMIN_ROLES = ["super_admin", "tenant_admin", "admin"] as const;

const router = Router();
router.use(requireAuth, attachStationScope, requireStationSelected, csrfProtection);

router.get("/config", (_req, res) => {
  res.json({ enabled: isCallRecordingEnabled() });
});

const uploadQuerySchema = z.object({
  callId: z.string().min(1).max(64),
  kioskId: z.coerce.number().int().positive().optional(),
  pumpId: z.coerce.number().int().positive().optional(),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
});

/**
 * Kayit gorevlinin (cagriyi YANITLAYAN taraf) tarayicisindan gelir - kiosk asla
 * arayan disinda bir rol oynamaz, dolayisiyla burasi ozel bir role KISITLANMAZ:
 * cagriyi kim yanitladiysa (requireAuth+requireStationSelected zaten yeterli) o
 * kendi kaydini yukleyebilir. Govde JSON DEGIL, ham ses (webm/opus) - raw()
 * yalnizca bu route icin, herhangi bir content-type'i kabul eder (MediaRecorder
 * tarayiciya gore "audio/webm;codecs=opus" gibi degisken bir deger yazabilir).
 */
router.post("/", raw({ type: () => true, limit: "26mb" }), validateQuery(uploadQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof uploadQuerySchema> }).validatedQuery;
  const buffer = req.body as Buffer;
  const mimeType = req.get("content-type") || "audio/webm";

  try {
    const row = saveRecording({
      stationId: req.stationId!,
      callId: q.callId,
      kioskId: q.kioskId ?? null,
      pumpId: q.pumpId ?? null,
      startedAt: q.startedAt,
      endedAt: q.endedAt,
      mimeType,
      buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0),
      recordedBy: req.user!,
    });
    res.status(201).json({ id: row.id });
  } catch (err) {
    if (err instanceof CallRecordingError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

function serialize(row: CallRecordingRow) {
  return {
    id: row.id,
    callId: row.call_id,
    kioskId: row.kiosk_id,
    pumpId: row.pump_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get("/", requireRole(...ADMIN_ROLES), validateQuery(listQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listQuerySchema> }).validatedQuery;
  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;
  const { recordings, total } = listRecordings(req.stationId!, limit, offset);
  res.json({ recordings: recordings.map(serialize), total });
});

/**
 * Hassas sesli veriye erisim - audit_log_viewed ile AYNI ilke (bkz. routes/auditLog.ts):
 * kim, hangi kaydi, ne zaman DINLEDI/INDIRDI kendisi de denetim izine yazilir.
 */
router.get("/:id/audio", requireRole(...ADMIN_ROLES), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "Gecersiz kayit id." });

  try {
    const row = getRecordingById(id, req.stationId!);
    const buffer = readRecordingFile(row);

    recordAudit({
      user: req.user!,
      action: "intercom_recording_played",
      entityType: "call_recording",
      entityId: row.id,
      details: { callId: row.call_id },
      ip: req.ip,
      stationId: req.stationId,
    });

    res.setHeader("Content-Type", row.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="interkom-kaydi-${row.id}"`);
    res.send(buffer);
  } catch (err) {
    if (err instanceof CallRecordingError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.get("/retention", requireRole(...ADMIN_ROLES), (req, res) => {
  res.json({ days: getRetentionDays(req.stationId!) });
});

const retentionSchema = z.object({ days: z.number().int().positive() });

router.patch("/retention", requireRole("super_admin", "tenant_admin"), validateBody(retentionSchema), (req, res) => {
  const body = req.body as z.infer<typeof retentionSchema>;
  try {
    const days = setRetentionDays(req.stationId!, body.days, req.user!);
    recordAudit({
      user: req.user!,
      action: "intercom_recording_retention_updated",
      details: { days },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.json({ days });
  } catch (err) {
    if (err instanceof CallRecordingError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as intercomRecordingsRouter };
