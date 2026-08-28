import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { TenantRow } from "../db/types.js";
import { csrfProtection, requireAuth, requireRole } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";

/**
 * Dagitim sirketleri (kiracilar).
 *
 * Kiraci acmak ve istasyon atamak TICARI bir karardir (kimin neyi isletecegi, faturalama),
 * bu yuzden yalnizca platform yoneticisine acilir - bir dagiticinin kendine istasyon
 * eklemesi ya da baska bir kiraci acmasi soz konusu degildir.
 */
const router = Router();
router.use(requireAuth, requireRole("super_admin"));

interface TenantWithStats extends TenantRow {
  station_count: number;
  user_count: number;
}

function serializeTenant(t: TenantWithStats) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    active: !!t.active,
    stationCount: t.station_count,
    userCount: t.user_count,
    createdAt: t.created_at,
  };
}

const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

router.get("/", validateQuery(listQuerySchema), (req, res) => {
  const { q, page: reqPage, pageSize: reqPageSize } = (
    req as unknown as { validatedQuery: z.infer<typeof listQuerySchema> }
  ).validatedQuery;

  const where = q ? "WHERE t.name LIKE ? OR t.slug LIKE ?" : "";
  const params = q ? [`%${q}%`, `%${q}%`] : [];

  const total = (
    db.prepare<unknown[], { count: number }>(`SELECT COUNT(*) AS count FROM tenants t ${where}`).get(...params) ?? {
      count: 0,
    }
  ).count;

  const pageSize = Math.min(Math.max(reqPageSize ?? 20, 1), 100);
  const page = Math.max(reqPage ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const tenants = db
    .prepare<unknown[], TenantWithStats>(
      `SELECT t.*,
              (SELECT COUNT(*) FROM stations s WHERE s.tenant_id = t.id) AS station_count,
              (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count
       FROM tenants t
       ${where}
       ORDER BY t.name
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  res.json({ tenants: tenants.map(serializeTenant), total, page, pageSize });
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "Kisa ad yalnizca kucuk harf, rakam ve tire icerebilir."),
});

router.post("/", csrfProtection, validateBody(createSchema), (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;
  const existing = db.prepare<[string], { id: number }>("SELECT id FROM tenants WHERE slug = ?").get(body.slug);
  if (existing) return void res.status(409).json({ error: "Bu kisa ad zaten kullaniliyor." });

  const result = db.prepare("INSERT INTO tenants (name, slug) VALUES (?, ?)").run(body.name, body.slug);
  const id = result.lastInsertRowid as number;

  recordAudit({ user: req.user!, action: "tenant_created", entityType: "tenant", entityId: id, details: body, ip: req.ip, stationId: null });
  res.status(201).json({ tenant: { id, name: body.name, slug: body.slug, active: true, stationCount: 0, userCount: 0 } });
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  active: z.boolean().optional(),
});

router.patch("/:id", csrfProtection, validateBody(updateSchema), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare<[number], TenantRow>("SELECT * FROM tenants WHERE id = ?").get(id);
  if (!existing) return void res.status(404).json({ error: "Dagitim sirketi bulunamadi." });

  const body = req.body as z.infer<typeof updateSchema>;
  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) {
    fields.push("name = ?");
    values.push(body.name);
  }
  if (body.active !== undefined) {
    fields.push("active = ?");
    values.push(body.active ? 1 : 0);
  }
  if (fields.length === 0) return void res.status(400).json({ error: "Guncellenecek alan yok." });

  values.push(id);
  db.prepare(`UPDATE tenants SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  recordAudit({ user: req.user!, action: "tenant_updated", entityType: "tenant", entityId: id, details: body, ip: req.ip, stationId: null });
  res.json({ tenant: { ...existing, ...body } });
});

const assignSchema = z.object({
  /** null: istasyonu kiracidan cikarir, platformun kendi istasyonu yapar. */
  tenantId: z.number().int().positive().nullable(),
});

/**
 * Bir istasyonu kiraciya bagla / kiracidan cikar.
 *
 * Istasyon tarafinda degil burada duruyor: "kim hangi istasyonu isletiyor" sorusu
 * kiracinin tanimina aittir ve yalnizca platform yoneticisi cevaplayabilir.
 */
router.patch("/stations/:stationId", csrfProtection, validateBody(assignSchema), (req, res) => {
  const stationId = Number(req.params.stationId);
  const station = db.prepare<[number], { id: number }>("SELECT id FROM stations WHERE id = ?").get(stationId);
  if (!station) return void res.status(404).json({ error: "Istasyon bulunamadi." });

  const { tenantId } = req.body as z.infer<typeof assignSchema>;
  if (tenantId !== null) {
    const tenant = db.prepare<[number], { id: number }>("SELECT id FROM tenants WHERE id = ?").get(tenantId);
    if (!tenant) return void res.status(400).json({ error: "Gecersiz dagitim sirketi." });
  }

  db.prepare("UPDATE stations SET tenant_id = ? WHERE id = ?").run(tenantId, stationId);

  recordAudit({
    user: req.user!,
    action: "station_tenant_assigned",
    entityType: "station",
    entityId: stationId,
    details: { tenantId },
    ip: req.ip,
    stationId,
  });
  res.json({ stationId, tenantId });
});

export const tenantsRouter = router;
