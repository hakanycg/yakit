import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { AuditLogRow } from "../db/types.js";
import { attachStationScope, requireAuth, requireRole } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";

const router = Router();
router.use(requireAuth, requireRole("super_admin"), attachStationScope);

const listSchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
  action: z.string().optional(),
  userId: z.coerce.number().int().positive().optional(),
});

router.get("/", validateQuery(listSchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listSchema> }).validatedQuery;
  const clauses: string[] = [];
  const params: unknown[] = [];

  // super_admin bir istasyon secmemisse tum istasyonlarin kayitlarini gorur; digerleri her zaman kendi istasyonuyla sinirlidir.
  if (req.stationId !== undefined) {
    clauses.push("station_id = ?");
    params.push(req.stationId);
  }
  if (q.action) {
    clauses.push("action = ?");
    params.push(q.action);
  }
  if (q.userId) {
    clauses.push("user_id = ?");
    params.push(q.userId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = q.limit ?? 200;
  const rows = db
    .prepare<unknown[], AuditLogRow>(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit);

  // "Erisim loglama": bu sayfayi kim, ne zaman, hangi filtrelerle goruntuledi - denetim
  // gunlugunun KENDISINE erisim de (mutasyonlar gibi) ayrica kayit altina alinir, tipki
  // CSV disa aktarma uclarindaki (transactions_exported vb.) mevcut davranis gibi.
  recordAudit({
    user: req.user!,
    action: "audit_log_viewed",
    details: { action: q.action ?? null, userId: q.userId ?? null, limit, resultCount: rows.length },
    ip: req.ip,
    stationId: req.stationId,
  });

  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      stationId: r.station_id,
      userId: r.user_id,
      username: r.username,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      details: r.details ? JSON.parse(r.details) : null,
      ipAddress: r.ip_address,
      createdAt: r.created_at,
    })),
  });
});

export { router as auditLogRouter };
