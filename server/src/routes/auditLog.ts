import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { AuditLogRow } from "../db/types.js";
import { attachStationScope, requireAuth, requireRole } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";

const router = Router();
router.use(requireAuth, requireRole("super_admin"), attachStationScope);

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.");

const listSchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
  action: z.string().optional(),
  userId: z.coerce.number().int().positive().optional(),
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(50).optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

router.get("/", validateQuery(listSchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listSchema> }).validatedQuery;
  const clauses: string[] = [];
  const params: unknown[] = [];

  // super_admin bir istasyon secmemisse tum istasyonlarin kayitlarini gorur; digerleri her zaman kendi istasyonuyla sinirlidir.
  // Not: asagidaki JOIN'den sonra stations tablosu da bir created_at kolonuna sahip
  // oldugundan tum kosullar audit_log. ile nitelenir - aksi halde SQLite "ambiguous
  // column name" hatasi verir.
  if (req.stationId !== undefined) {
    clauses.push("audit_log.station_id = ?");
    params.push(req.stationId);
  }
  if (q.action) {
    clauses.push("audit_log.action = ?");
    params.push(q.action);
  }
  if (q.userId) {
    clauses.push("audit_log.user_id = ?");
    params.push(q.userId);
  }
  if (q.entityType) {
    clauses.push("audit_log.entity_type = ?");
    params.push(q.entityType);
  }
  if (q.entityId) {
    clauses.push("audit_log.entity_id = ?");
    params.push(q.entityId);
  }
  if (q.from) {
    clauses.push("audit_log.created_at >= ?");
    params.push(q.from);
  }
  if (q.to) {
    clauses.push("audit_log.created_at <= ?");
    params.push(`${q.to}T23:59:59.999Z`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = q.limit ?? 200;
  // Istasyon adi LEFT JOIN ile eklenir: bir istasyon secilmeden goruntulendiginde
  // (bkz. yukaridaki "tum istasyonlar" yorumu) satirlar birbirinden farkli
  // istasyonlara ait olabilir - hangisine ait oldugu tabloda gorunmeli.
  const rows = db
    .prepare<unknown[], AuditLogRow & { station_name: string | null }>(
      `SELECT audit_log.*, stations.name AS station_name
         FROM audit_log
         LEFT JOIN stations ON stations.id = audit_log.station_id
         ${where}
        ORDER BY audit_log.created_at DESC LIMIT ?`
    )
    .all(...params, limit);

  // "Erisim loglama": bu sayfayi kim, ne zaman, hangi filtrelerle goruntuledi - denetim
  // gunlugunun KENDISINE erisim de (mutasyonlar gibi) ayrica kayit altina alinir, tipki
  // CSV disa aktarma uclarindaki (transactions_exported vb.) mevcut davranis gibi.
  // Uygulanmamis suzgecler detaya HIC yazilmaz. Onceden `action: null, userId: null`
  // olarak yaziliyordu: logu okuyan kisi bunu "veri eksik/bozuk" diye okuyor, oysa
  // anlami sadece "suzgec kullanilmadi" idi. Yoklugun kendisi zaten bu bilgiyi verir.
  const viewDetails: Record<string, unknown> = { limit, resultCount: rows.length };
  if (q.action) viewDetails.action = q.action;
  if (q.userId) viewDetails.userId = q.userId;
  if (q.entityType) viewDetails.entityType = q.entityType;
  if (q.entityId) viewDetails.entityId = q.entityId;
  if (q.from) viewDetails.from = q.from;
  if (q.to) viewDetails.to = q.to;

  recordAudit({
    user: req.user!,
    action: "audit_log_viewed",
    details: viewDetails,
    ip: req.ip,
    stationId: req.stationId,
  });

  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      stationId: r.station_id,
      stationName: r.station_name,
      userId: r.user_id,
      username: r.username,
      actorType: r.actor_type,
      role: r.role,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      details: r.details ? JSON.parse(r.details) : null,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      createdAt: r.created_at,
    })),
  });
});

export { router as auditLogRouter };
