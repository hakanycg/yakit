import { randomBytes, createHash } from "node:crypto";
import { db } from "../db/index.js";
import type { UserRow } from "../db/types.js";
import { hashPassword, validatePasswordPolicy } from "../utils/password.js";
import { sendEmail, sendSms } from "./notificationService.js";
import { destroyAllSessionsForUser } from "./sessionService.js";
import { recordAudit } from "./auditService.js";
import { logger } from "../utils/logger.js";

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 dakika

export class PasswordResetError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Kullanici adi VEYA e-posta ile eslesen hesap icin bir sifre sifirlama bagi olusturur ve
 * kayitli e-posta/telefon varsa gonderir (kritik alarm bildirim tercihinden - notify_email/
 * notify_sms - bagimsizdir; bu bir hesap guvenligi islemidir, operasyonel bir uyari degil).
 * Hesap bulunamasa veya iletisim bilgisi olmasa da HER ZAMAN sessizce doner - cagiran taraf
 * (route) kullaniciya her durumda ayni jenerik mesaji gostermelidir; aksi halde kullanici adi/
 * e-posta varligi sizdirilmis olur.
 */
export async function requestPasswordReset(identifier: string, requestBaseUrl: string, ip: string | undefined): Promise<void> {
  const trimmed = identifier.trim();
  if (!trimmed) return;

  const user = db
    .prepare<[string, string], UserRow>("SELECT * FROM users WHERE username = ? OR lower(email) = lower(?)")
    .get(trimmed.toLowerCase(), trimmed);

  if (!user || !user.active) {
    recordAudit({ user: null, actorType: "anonymous", actorLabel: trimmed, action: "password_reset_requested", details: { identifier: trimmed, found: false }, ip });
    return;
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

  db.prepare("UPDATE users SET reset_token_hash = ?, reset_token_expires_at = ? WHERE id = ?").run(tokenHash, expiresAt, user.id);

  const resetLink = `${requestBaseUrl}/sifre-sifirla?token=${token}`;
  const minutes = RESET_TOKEN_TTL_MS / 60000;

  let delivered = false;
  if (user.email) {
    const result = await sendEmail(
      user.email,
      "Sifre Sifirlama Talebi",
      `Merhaba ${user.display_name},\n\nHesabiniz icin bir sifre sifirlama talebi alindi. Asagidaki baglantiya tiklayarak yeni bir sifre belirleyebilirsiniz (${minutes} dakika gecerlidir):\n\n${resetLink}\n\nBu talebi siz yapmadiysaniz bu e-postayi yok sayabilirsiniz; sifreniz degismez.`,
      `<p>Merhaba ${user.display_name},</p><p>Hesabiniz icin bir sifre sifirlama talebi alindi. Asagidaki baglantiya tiklayarak yeni bir sifre belirleyebilirsiniz (${minutes} dakika gecerlidir):</p><p><a href="${resetLink}">${resetLink}</a></p><p>Bu talebi siz yapmadiysaniz bu e-postayi yok sayabilirsiniz; sifreniz degismez.</p>`
    );
    delivered = delivered || result.sent;
  }
  if (user.phone) {
    const result = await sendSms(user.phone, `Sifre sifirlama baglantiniz (${minutes} dk gecerli): ${resetLink}`);
    delivered = delivered || result.sent;
  }

  recordAudit({ user, action: "password_reset_requested", details: { found: true, delivered }, ip });
  if (!delivered) {
    logger.warn(
      { userId: user.id },
      "Sifre sifirlama bagi olusturuldu ama gonderilemedi (e-posta/telefon kayitli degil veya SMTP/SMS yapilandirilmamis)."
    );
  }
}

/** Bag gecerliyse sifreyi degistirir, tum oturumlari sonlandirir ve bagi tek kullanimlik yakar. */
export function resetPasswordWithToken(token: string, newPassword: string, ip: string | undefined): void {
  if (!token) throw new PasswordResetError("Gecersiz veya suresi dolmus bag.", 400);

  const tokenHash = hashResetToken(token);
  const user = db.prepare<[string], UserRow>("SELECT * FROM users WHERE reset_token_hash = ?").get(tokenHash);

  if (!user || !user.reset_token_expires_at || new Date(user.reset_token_expires_at).getTime() < Date.now()) {
    throw new PasswordResetError("Gecersiz veya suresi dolmus bag. Lutfen yeni bir sifre sifirlama talebi olusturun.", 400);
  }

  const errors = validatePasswordPolicy(newPassword);
  if (errors.length > 0) throw new PasswordResetError(errors.join(" "), 400);

  const hashed = hashPassword(newPassword);
  db.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?,
       must_change_password = 0, failed_login_attempts = 0, locked_until = NULL,
       reset_token_hash = NULL, reset_token_expires_at = NULL, updated_at = ?
     WHERE id = ?`
  ).run(hashed.hash, hashed.salt, hashed.iterations, new Date().toISOString(), user.id);

  destroyAllSessionsForUser(user.id);
  recordAudit({ user, action: "password_reset_completed", ip });
}
