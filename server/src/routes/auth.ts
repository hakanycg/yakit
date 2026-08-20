import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { RoleRow, UserRow } from "../db/types.js";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../utils/password.js";
import { createSession, destroySession } from "../services/sessionService.js";
import { recordAudit } from "../services/auditService.js";
import { PasswordResetError, requestPasswordReset, resetPasswordWithToken } from "../services/passwordResetService.js";
import { validateBody } from "../middleware/validate.js";
import { loginRateLimit, passwordResetRateLimit } from "../middleware/rateLimit.js";
import { clearSessionCookies, csrfProtection, requireAuth, setSessionCookies } from "../middleware/auth.js";
import { env } from "../config.js";

const router = Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

router.post("/login", loginRateLimit, validateBody(loginSchema), (req, res) => {
  const { username, password } = req.body as z.infer<typeof loginSchema>;
  const ip = req.ip;

  const user = db.prepare<[string], UserRow>("SELECT * FROM users WHERE username = ?").get(username.trim().toLowerCase());

  // Kullanici bulunamasa da sabit is yapip zamanlama sizintisini azaltiyoruz.
  const dummy = hashPassword("timing-safety-noop");
  const target = user
    ? { hash: user.password_hash, salt: user.password_salt, iterations: user.password_iterations }
    : dummy;
  const passwordOk = verifyPassword(password, target);

  if (!user) {
    recordAudit({ user: null, action: "login_failed", details: { username, reason: "not_found" }, ip });
    res.status(401).json({ error: "Kullanici adi veya sifre hatali." });
    return;
  }

  if (!user.active) {
    recordAudit({ user, action: "login_failed", details: { reason: "inactive" }, ip });
    res.status(403).json({ error: "Hesabiniz devre disi birakilmis." });
    return;
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    recordAudit({ user, action: "login_failed", details: { reason: "locked" }, ip });
    res.status(423).json({ error: "Hesap gecici olarak kilitlendi. Lutfen daha sonra tekrar deneyin." });
    return;
  }

  if (!passwordOk) {
    const attempts = user.failed_login_attempts + 1;
    const lockUntil = attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;
    db.prepare("UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?").run(
      attempts,
      lockUntil,
      user.id
    );
    recordAudit({ user, action: "login_failed", details: { reason: "bad_password", attempts }, ip });
    res.status(401).json({ error: "Kullanici adi veya sifre hatali." });
    return;
  }

  db.prepare(
    "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), user.id);

  const { token, csrfToken } = createSession(user, ip, req.headers["user-agent"]);
  setSessionCookies(res, token, csrfToken);

  const role = db.prepare<[number], RoleRow>("SELECT * FROM roles WHERE id = ?").get(user.role_id)!;
  recordAudit({ user, action: "login_success", ip });

  res.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: role.name,
      stationId: user.station_id,
      mustChangePassword: !!user.must_change_password,
    },
  });
});

const forgotPasswordSchema = z.object({ identifier: z.string().min(1).max(120) });

router.post("/forgot-password", passwordResetRateLimit, validateBody(forgotPasswordSchema), async (req, res) => {
  const { identifier } = req.body as z.infer<typeof forgotPasswordSchema>;
  const baseUrl = env.PUBLIC_API_BASE_URL ?? `${req.protocol}://${req.get("host")}`;
  await requestPasswordReset(identifier, baseUrl, req.ip);
  // Hesap bulunsa da bulunmasa da HER ZAMAN ayni jenerik yanit - kullanici adi/e-posta
  // varligini sizdirmamak icin (bkz. passwordResetService.ts).
  res.json({ message: "Bu bilgilerle eslesen bir hesap varsa, sifre sifirlama talimatlari gonderildi." });
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(1),
});

router.post("/reset-password", passwordResetRateLimit, validateBody(resetPasswordSchema), (req, res) => {
  const { token, newPassword } = req.body as z.infer<typeof resetPasswordSchema>;
  try {
    resetPasswordWithToken(token, newPassword, req.ip);
    res.status(204).end();
  } catch (err) {
    if (err instanceof PasswordResetError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post("/logout", requireAuth, csrfProtection, (req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken);
  recordAudit({ user: req.user ?? null, action: "logout", ip: req.ip });
  clearSessionCookies(res);
  res.status(204).end();
});

router.get("/me", requireAuth, (req, res) => {
  const user = req.user!;
  const role = req.role!;
  res.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: role.name,
      stationId: user.station_id,
      mustChangePassword: !!user.must_change_password,
      email: user.email,
      phone: user.phone,
      notifyEmail: !!user.notify_email,
      notifySms: !!user.notify_sms,
    },
    csrfToken: req.csrfToken,
  });
});

const notificationSettingsSchema = z.object({
  email: z.string().email().max(120).nullable().optional(),
  phone: z
    .string()
    .regex(/^\+?[0-9 ]{10,16}$/, "Gecersiz telefon numarasi.")
    .nullable()
    .optional(),
  notifyEmail: z.boolean().optional(),
  notifySms: z.boolean().optional(),
});

router.patch("/notification-settings", requireAuth, csrfProtection, validateBody(notificationSettingsSchema), (req, res) => {
  const user = req.user!;
  const body = req.body as z.infer<typeof notificationSettingsSchema>;

  if (body.email !== undefined) {
    db.prepare("UPDATE users SET email = ?, updated_at = ? WHERE id = ?").run(body.email, new Date().toISOString(), user.id);
  }
  if (body.phone !== undefined) {
    db.prepare("UPDATE users SET phone = ?, updated_at = ? WHERE id = ?").run(body.phone, new Date().toISOString(), user.id);
  }
  if (body.notifyEmail !== undefined) {
    db.prepare("UPDATE users SET notify_email = ?, updated_at = ? WHERE id = ?").run(
      body.notifyEmail ? 1 : 0,
      new Date().toISOString(),
      user.id
    );
  }
  if (body.notifySms !== undefined) {
    db.prepare("UPDATE users SET notify_sms = ?, updated_at = ? WHERE id = ?").run(
      body.notifySms ? 1 : 0,
      new Date().toISOString(),
      user.id
    );
  }

  recordAudit({ user, action: "notification_settings_updated", details: body, ip: req.ip });
  res.status(204).end();
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

router.post("/change-password", requireAuth, csrfProtection, validateBody(changePasswordSchema), (req, res) => {
  const user = req.user!;
  const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;

  const ok = verifyPassword(currentPassword, {
    hash: user.password_hash,
    salt: user.password_salt,
    iterations: user.password_iterations,
  });
  if (!ok) {
    res.status(401).json({ error: "Mevcut sifre hatali." });
    return;
  }

  const errors = validatePasswordPolicy(newPassword);
  if (errors.length > 0) {
    res.status(400).json({ error: "Sifre politikasi saglanmiyor.", details: errors });
    return;
  }

  const hashed = hashPassword(newPassword);
  db.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 0, updated_at = ? WHERE id = ?"
  ).run(hashed.hash, hashed.salt, hashed.iterations, new Date().toISOString(), user.id);

  recordAudit({ user, action: "password_changed", ip: req.ip });
  res.status(204).end();
});

export { router as authRouter };
