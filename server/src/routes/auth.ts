import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { RoleRow, UserRow } from "../db/types.js";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../utils/password.js";
import { buildOtpauthUri, generateTotpSecret, verifyTotpCode } from "../utils/totp.js";
import { createSession, destroySession } from "../services/sessionService.js";
import { recordAudit } from "../services/auditService.js";
import { PasswordResetError, requestPasswordReset, resetPasswordWithToken } from "../services/passwordResetService.js";
import { createTotpChallenge, deleteTotpChallenge, peekTotpChallenge, registerFailedTotpAttempt } from "../services/totpChallengeService.js";
import { validateBody } from "../middleware/validate.js";
import { loginRateLimit, passwordResetRateLimit } from "../middleware/rateLimit.js";
import { clearSessionCookies, csrfProtection, requireAuth, setSessionCookies } from "../middleware/auth.js";
import { env } from "../config.js";

const router = Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function loginResponseUser(user: UserRow, role: RoleRow) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: role.name,
    stationId: user.station_id,
    mustChangePassword: !!user.must_change_password,
  };
}

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

  if (user.totp_enabled) {
    // Sifre dogru ama hesapta 2FA acik: oturum HENUZ acilmaz, once dogrulama kodu istenir.
    const challengeToken = createTotpChallenge(user.id);
    recordAudit({ user, action: "login_totp_challenge_issued", ip });
    res.json({ requiresTotp: true, challengeToken });
    return;
  }

  const { token, csrfToken } = createSession(user, ip, req.headers["user-agent"]);
  setSessionCookies(res, token, csrfToken);

  const role = db.prepare<[number], RoleRow>("SELECT * FROM roles WHERE id = ?").get(user.role_id)!;
  recordAudit({ user, action: "login_success", ip });

  res.json({ user: loginResponseUser(user, role) });
});

const totpLoginSchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().min(4).max(10),
});

router.post("/login/totp", loginRateLimit, validateBody(totpLoginSchema), (req, res) => {
  const { challengeToken, code } = req.body as z.infer<typeof totpLoginSchema>;
  const ip = req.ip;

  const userId = peekTotpChallenge(challengeToken);
  const user = userId ? db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(userId) : undefined;

  if (!user || !user.active || !user.totp_enabled || !user.totp_secret) {
    deleteTotpChallenge(challengeToken);
    res.status(401).json({ error: "Oturum acma suresi doldu. Lutfen tekrar giris yapin." });
    return;
  }

  if (!verifyTotpCode(user.totp_secret, code)) {
    const hasMoreAttempts = registerFailedTotpAttempt(challengeToken);
    recordAudit({ user, action: "login_totp_failed", ip });
    res.status(401).json({
      error: hasMoreAttempts ? "Gecersiz dogrulama kodu." : "Cok fazla hatali deneme. Lutfen tekrar giris yapin.",
    });
    return;
  }

  deleteTotpChallenge(challengeToken);
  const { token, csrfToken } = createSession(user, ip, req.headers["user-agent"]);
  setSessionCookies(res, token, csrfToken);

  const role = db.prepare<[number], RoleRow>("SELECT * FROM roles WHERE id = ?").get(user.role_id)!;
  recordAudit({ user, action: "login_success", details: { totp: true }, ip });

  res.json({ user: loginResponseUser(user, role) });
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
      totpEnabled: !!user.totp_enabled,
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

/** Kurulumu baslatir: yeni bir "pending" sir uretir (henuz etkinlestirilmez) ve authenticator uygulamasina eklenecek bilgileri dondurur. Tekrar cagrilirsa onceki pending sir gecersizlenir. */
router.post("/2fa/setup", requireAuth, csrfProtection, (req, res) => {
  const user = req.user!;
  const secret = generateTotpSecret();
  db.prepare("UPDATE users SET totp_pending_secret = ?, updated_at = ? WHERE id = ?").run(secret, new Date().toISOString(), user.id);
  res.json({ secret, otpauthUri: buildOtpauthUri(secret, user.username) });
});

const totpEnableSchema = z.object({ code: z.string().min(4).max(10) });

/** Kurulumu, authenticator uygulamasinda uretilen kodu dogrulatarak tamamlar. */
router.post("/2fa/enable", requireAuth, csrfProtection, validateBody(totpEnableSchema), (req, res) => {
  const user = req.user!;
  const { code } = req.body as z.infer<typeof totpEnableSchema>;

  if (!user.totp_pending_secret) {
    res.status(400).json({ error: "Once kurulumu baslatmalisiniz." });
    return;
  }
  if (!verifyTotpCode(user.totp_pending_secret, code)) {
    res.status(400).json({ error: "Gecersiz dogrulama kodu." });
    return;
  }

  db.prepare(
    "UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_pending_secret = NULL, updated_at = ? WHERE id = ?"
  ).run(user.totp_pending_secret, new Date().toISOString(), user.id);

  recordAudit({ user, action: "totp_enabled", ip: req.ip });
  res.status(204).end();
});

const totpDisableSchema = z.object({ password: z.string().min(1) });

/** 2FA'yi kapatir - hesabin ele gecirilmis bir oturumdan kolayca kapatilamamasi icin mevcut sifre yeniden istenir. */
router.post("/2fa/disable", requireAuth, csrfProtection, validateBody(totpDisableSchema), (req, res) => {
  const user = req.user!;
  const { password } = req.body as z.infer<typeof totpDisableSchema>;

  const ok = verifyPassword(password, { hash: user.password_hash, salt: user.password_salt, iterations: user.password_iterations });
  if (!ok) {
    res.status(401).json({ error: "Sifre hatali." });
    return;
  }

  db.prepare(
    "UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_pending_secret = NULL, updated_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), user.id);

  recordAudit({ user, action: "totp_disabled", ip: req.ip });
  res.status(204).end();
});

export { router as authRouter };
