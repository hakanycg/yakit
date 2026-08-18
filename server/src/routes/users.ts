import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { RoleRow, UserRow } from "../db/types.js";
import { requireAuth, requireRole, csrfProtection } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { hashPassword, validatePasswordPolicy } from "../utils/password.js";
import { destroyAllSessionsForUser } from "../services/sessionService.js";
import { recordAudit } from "../services/auditService.js";

const router = Router();
router.use(requireAuth, requireRole("admin"), csrfProtection);

function serializeUser(u: UserRow, roleName: string) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: roleName,
    active: !!u.active,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    locked: !!(u.locked_until && new Date(u.locked_until).getTime() > Date.now()),
  };
}

router.get("/", (_req, res) => {
  const rows = db
    .prepare<[], UserRow & { role_name: string }>(
      `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.username`
    )
    .all();
  res.json({ users: rows.map((r) => serializeUser(r, r.role_name)) });
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
  role: z.enum(["admin", "operator", "viewer"]),
});

router.post("/", validateBody(createUserSchema), (req, res) => {
  const body = req.body as z.infer<typeof createUserSchema>;
  const username = body.username.toLowerCase();

  const existing = db.prepare<[string], UserRow>("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return void res.status(409).json({ error: "Bu kullanici adi zaten kullaniliyor." });

  const errors = validatePasswordPolicy(body.password);
  if (errors.length > 0) return void res.status(400).json({ error: "Sifre politikasi saglanmiyor.", details: errors });

  const role = db.prepare<[string], RoleRow>("SELECT * FROM roles WHERE name = ?").get(body.role);
  if (!role) return void res.status(400).json({ error: "Gecersiz rol." });

  const hashed = hashPassword(body.password);
  const result = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, password_salt, password_iterations, role_id, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(username, body.displayName, hashed.hash, hashed.salt, hashed.iterations, role.id);

  recordAudit({ user: req.user!, action: "user_created", entityType: "user", entityId: result.lastInsertRowid as number, details: { username, role: role.name }, ip: req.ip });
  const created = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid as number)!;
  res.status(201).json({ user: serializeUser(created, role.name) });
});

const updateUserSchema = z.object({
  displayName: z.string().min(2).max(80).optional(),
  role: z.enum(["admin", "operator", "viewer"]).optional(),
  active: z.boolean().optional(),
  resetPassword: z.string().optional(),
});

router.patch("/:id", validateBody(updateUserSchema), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(id);
  if (!target) return void res.status(404).json({ error: "Kullanici bulunamadi." });

  const body = req.body as z.infer<typeof updateUserSchema>;

  if (id === req.user!.id && body.active === false) {
    return void res.status(400).json({ error: "Kendi hesabinizi devre disi birakamazsiniz." });
  }

  if (body.displayName !== undefined) {
    db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").run(body.displayName, new Date().toISOString(), id);
  }
  if (body.role !== undefined) {
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

  recordAudit({ user: req.user!, action: "user_updated", entityType: "user", entityId: id, details: { ...body, resetPassword: body.resetPassword ? true : undefined }, ip: req.ip });

  const updated = db
    .prepare<[number], UserRow & { role_name: string }>(
      `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
    )
    .get(id)!;
  res.json({ user: serializeUser(updated, updated.role_name) });
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) return void res.status(400).json({ error: "Kendi hesabinizi silemezsiniz." });
  const target = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(id);
  if (!target) return void res.status(404).json({ error: "Kullanici bulunamadi." });

  destroyAllSessionsForUser(id);
  db.prepare("UPDATE users SET active = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  recordAudit({ user: req.user!, action: "user_deactivated", entityType: "user", entityId: id, ip: req.ip });
  res.status(204).end();
});

export { router as usersRouter };
