import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { RoleRow, StationRow, UserRow } from "../db/types.js";
import { attachStationScope, requireAuth, requireRole, csrfProtection } from "../middleware/auth.js";
import { canAccessStation, stationScopeFilter } from "../middleware/tenantScope.js";
import { validateBody } from "../middleware/validate.js";
import { hashPassword, validatePasswordPolicy } from "../utils/password.js";
import { destroyAllSessionsForUser } from "../services/sessionService.js";
import { recordAudit } from "../services/auditService.js";

const router = Router();
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, csrfProtection);

/** Dagitim sirketi yoneticisi, kendi kiracisi icinde super_admin gibi davranir: istasyon secebilir. */
function isTenantAdmin(req: { role?: { name: string } }): boolean {
  return req.role?.name === "tenant_admin";
}

function serializeUser(u: UserRow, roleName: string, stationName: string | null) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: roleName,
    stationId: u.station_id,
    stationName,
    active: !!u.active,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    locked: !!(u.locked_until && new Date(u.locked_until).getTime() > Date.now()),
    email: u.email,
    phone: u.phone,
    notifyEmail: !!u.notify_email,
    notifySms: !!u.notify_sms,
  };
}

router.get("/", (req, res) => {
  // Istasyon secilmisse ona, secilmemisse kiraci kapsamina daraltilir. tenant_admin
  // icin bu SART: kapsam uygulanmazsa istasyon secmeden butun platformun kullanicilari
  // donerdi.
  const scoped = req.stationId !== undefined;
  const tenantScope = stationScopeFilter(req, "u.station_id");
  const where = scoped ? "WHERE u.station_id = ?" : `WHERE ${tenantScope.sql}`;
  const params: unknown[] = scoped ? [req.stationId] : tenantScope.params;

  const rows = db
    .prepare<unknown[], UserRow & { role_name: string; station_name: string | null }>(
      `SELECT u.*, r.name as role_name, s.name as station_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN stations s ON s.id = u.station_id
       ${where}
       ORDER BY u.username`
    )
    .all(...params);

  res.json({ users: rows.map((r) => serializeUser(r, r.role_name, r.station_name)) });
});

router.get("/roles", (_req, res) => {
  const roles = db.prepare<[], RoleRow>("SELECT * FROM roles ORDER BY name").all();
  res.json({ roles: roles.map((r) => ({ id: r.id, name: r.name, description: r.description })) });
});

const createUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-z0-9._-]+$/, "Kullanici adi yalnizca kucuk harf, rakam, nokta, tire ve alt cizgi icerebilir."),
  displayName: z.string().min(2).max(80),
  password: z.string().min(1),
  role: z.enum(["super_admin", "tenant_admin", "admin", "operator", "viewer"]),
  stationId: z.number().int().positive().optional(),
  /** Yalnizca tenant_admin rolu icin: yonetecegi dagitim sirketi. */
  tenantId: z.number().int().positive().optional(),
  email: z.string().email().max(120).optional(),
  phone: z
    .string()
    .regex(/^\+?[0-9 ]{10,16}$/, "Gecersiz telefon numarasi.")
    .optional(),
});

router.post("/", validateBody(createUserSchema), (req, res) => {
  const body = req.body as z.infer<typeof createUserSchema>;
  const username = body.username.toLowerCase();
  const requesterIsSuperAdmin = req.role!.name === "super_admin";

  if (body.role === "super_admin" && !requesterIsSuperAdmin) {
    return void res.status(403).json({ error: "Yalnizca super admin baska bir super admin hesabi olusturabilir." });
  }
  // Kiraci yoneticisi hesabini yalnizca platform acabilir: bu rol, bir dagitim
  // sirketinin TUM istasyonlarina erisim demektir ve ticari bir karardir.
  if (body.role === "tenant_admin" && !requesterIsSuperAdmin) {
    return void res.status(403).json({ error: "Dagitim sirketi yoneticisi hesabini yalnizca platform yoneticisi acabilir." });
  }

  let targetStationId: number | null;
  let targetTenantId: number | null = null;
  if (body.role === "tenant_admin") {
    targetStationId = null;
    if (!body.tenantId) return void res.status(400).json({ error: "Bir dagitim sirketi secmelisiniz." });
    const tenant = db.prepare<[number], { id: number }>("SELECT id FROM tenants WHERE id = ?").get(body.tenantId);
    if (!tenant) return void res.status(400).json({ error: "Gecersiz dagitim sirketi." });
    targetTenantId = body.tenantId;
  } else if (body.role === "super_admin") {
    targetStationId = null;
  } else if (requesterIsSuperAdmin || isTenantAdmin(req)) {
    if (!body.stationId) return void res.status(400).json({ error: "Bir istasyon secmelisiniz." });
    const station = db.prepare<[number], StationRow>("SELECT id FROM stations WHERE id = ?").get(body.stationId);
    if (!station) return void res.status(400).json({ error: "Gecersiz istasyon." });
    // Kiraci yoneticisi yalnizca KENDI istasyonlarina kullanici atayabilir.
    if (!canAccessStation(req, body.stationId)) {
      return void res.status(403).json({ error: "Bu istasyona kullanici ekleme yetkiniz yok." });
    }
    targetStationId = body.stationId;
  } else {
    targetStationId = req.stationId!;
  }

  const existing = db.prepare<[string], UserRow>("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return void res.status(409).json({ error: "Bu kullanici adi zaten kullaniliyor." });

  const errors = validatePasswordPolicy(body.password);
  if (errors.length > 0) return void res.status(400).json({ error: "Sifre politikasi saglanmiyor.", details: errors });

  const role = db.prepare<[string], RoleRow>("SELECT * FROM roles WHERE name = ?").get(body.role);
  if (!role) return void res.status(400).json({ error: "Gecersiz rol." });

  const hashed = hashPassword(body.password);
  const result = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, password_salt, password_iterations, role_id, station_id, tenant_id, email, phone, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      username,
      body.displayName,
      hashed.hash,
      hashed.salt,
      hashed.iterations,
      role.id,
      targetStationId,
      targetTenantId,
      body.email ?? null,
      body.phone ?? null
    );

  recordAudit({
    user: req.user!,
    action: "user_created",
    entityType: "user",
    entityId: result.lastInsertRowid as number,
    details: { username, role: role.name, stationId: targetStationId, tenantId: targetTenantId },
    ip: req.ip,
    stationId: targetStationId,
  });
  const created = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid as number)!;
  const stationName = targetStationId
    ? (db.prepare<[number], { name: string }>("SELECT name FROM stations WHERE id = ?").get(targetStationId)?.name ?? null)
    : null;
  res.status(201).json({ user: serializeUser(created, role.name, stationName) });
});

const updateUserSchema = z.object({
  displayName: z.string().min(2).max(80).optional(),
  role: z.enum(["admin", "operator", "viewer"]).optional(),
  active: z.boolean().optional(),
  resetPassword: z.string().optional(),
  email: z.string().email().max(120).nullable().optional(),
  phone: z
    .string()
    .regex(/^\+?[0-9 ]{10,16}$/, "Gecersiz telefon numarasi.")
    .nullable()
    .optional(),
  notifyEmail: z.boolean().optional(),
  notifySms: z.boolean().optional(),
});

router.patch("/:id", validateBody(updateUserSchema), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(id);
  if (!target) return void res.status(404).json({ error: "Kullanici bulunamadi." });

  const requesterIsSuperAdmin = req.role!.name === "super_admin";
  const canEditTarget = requesterIsSuperAdmin
    ? true
    : target.station_id !== null && canAccessStation(req, target.station_id);
  if (!canEditTarget) {
    // Var olmayan ve erisilemeyen kullanici ayni cevabi alir: hangi id'lerin var
    // oldugu sizdirilmaz.
    return void res.status(404).json({ error: "Kullanici bulunamadi." });
  }

  const body = req.body as z.infer<typeof updateUserSchema>;

  if (id === req.user!.id && body.active === false) {
    return void res.status(400).json({ error: "Kendi hesabinizi devre disi birakamazsiniz." });
  }

  if (body.displayName !== undefined) {
    db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").run(body.displayName, new Date().toISOString(), id);
  }
  if (body.role !== undefined) {
    if (target.station_id === null) {
      return void res.status(400).json({ error: "Super admin rolunu bu ekrandan degistiremezsiniz." });
    }
    const role = db.prepare<[string], RoleRow>("SELECT * FROM roles WHERE name = ?").get(body.role);
    if (!role) return void res.status(400).json({ error: "Gecersiz rol." });
    if (id === req.user!.id && body.role !== "admin") {
      return void res.status(400).json({ error: "Kendi yonetici rolunuzu degistiremezsiniz." });
    }
    db.prepare("UPDATE users SET role_id = ?, updated_at = ? WHERE id = ?").run(role.id, new Date().toISOString(), id);
  }
  if (body.active !== undefined) {
    db.prepare("UPDATE users SET active = ?, updated_at = ? WHERE id = ?").run(body.active ? 1 : 0, new Date().toISOString(), id);
    if (!body.active) destroyAllSessionsForUser(id);
  }
  if (body.resetPassword) {
    const errors = validatePasswordPolicy(body.resetPassword);
    if (errors.length > 0) return void res.status(400).json({ error: "Sifre politikasi saglanmiyor.", details: errors });
    const hashed = hashPassword(body.resetPassword);
    db.prepare(
      "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 1, updated_at = ? WHERE id = ?"
    ).run(hashed.hash, hashed.salt, hashed.iterations, new Date().toISOString(), id);
    destroyAllSessionsForUser(id);
  }
  if (body.email !== undefined) {
    db.prepare("UPDATE users SET email = ?, updated_at = ? WHERE id = ?").run(body.email, new Date().toISOString(), id);
  }
  if (body.phone !== undefined) {
    db.prepare("UPDATE users SET phone = ?, updated_at = ? WHERE id = ?").run(body.phone, new Date().toISOString(), id);
  }
  if (body.notifyEmail !== undefined) {
    db.prepare("UPDATE users SET notify_email = ?, updated_at = ? WHERE id = ?").run(body.notifyEmail ? 1 : 0, new Date().toISOString(), id);
  }
  if (body.notifySms !== undefined) {
    db.prepare("UPDATE users SET notify_sms = ?, updated_at = ? WHERE id = ?").run(body.notifySms ? 1 : 0, new Date().toISOString(), id);
  }

  recordAudit({
    user: req.user!,
    action: "user_updated",
    entityType: "user",
    entityId: id,
    details: { ...body, resetPassword: body.resetPassword ? true : undefined },
    ip: req.ip,
    stationId: target.station_id,
  });

  const updated = db
    .prepare<[number], UserRow & { role_name: string; station_name: string | null }>(
      `SELECT u.*, r.name as role_name, s.name as station_name FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN stations s ON s.id = u.station_id WHERE u.id = ?`
    )
    .get(id)!;
  res.json({ user: serializeUser(updated, updated.role_name, updated.station_name) });
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) return void res.status(400).json({ error: "Kendi hesabinizi silemezsiniz." });
  const target = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(id);
  if (!target) return void res.status(404).json({ error: "Kullanici bulunamadi." });

  const requesterIsSuperAdmin = req.role!.name === "super_admin";
  if (!requesterIsSuperAdmin && target.station_id !== req.stationId) {
    return void res.status(404).json({ error: "Kullanici bulunamadi." });
  }

  destroyAllSessionsForUser(id);
  db.prepare("UPDATE users SET active = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  recordAudit({ user: req.user!, action: "user_deactivated", entityType: "user", entityId: id, ip: req.ip, stationId: target.station_id });
  res.status(204).end();
});

export { router as usersRouter };
