import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";

let transporter: Transporter | null = null;
let transporterInitError = false;

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  if (transporter) return transporter;
  if (transporterInitError) return null;

  try {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    return transporter;
  } catch (err) {
    transporterInitError = true;
    logger.error({ err }, "SMTP transporter olusturulamadi.");
    return null;
  }
}

export interface SendResult {
  sent: boolean;
  reason?: string;
}

/** SMTP yapilandirilmamissa sessizce (hata firlatmadan) atlanir; bu, ozelligin gelistirme ortaminda kirilmasini onler. */
export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<SendResult> {
  const t = getTransporter();
  if (!t) {
    logger.warn({ to, subject }, "SMTP yapilandirilmadigi icin e-posta gonderilemedi (SMTP_HOST bos).");
    return { sent: false, reason: "SMTP yapilandirilmamis." };
  }
  try {
    await t.sendMail({ from: env.SMTP_FROM, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    logger.error({ err, to, subject }, "E-posta gonderimi basarisiz.");
    return { sent: false, reason: err instanceof Error ? err.message : "Bilinmeyen hata." };
  }
}

/**
 * Genel amacli HTTP tabanli SMS gonderimi. Saglayicinizin (Netgsm, Iletimerkezi,
 * Twilio vb.) beklediği istek govdesi farkli olabilir; SMS_PROVIDER_URL'i kendi
 * saglayicinizin REST endpoint'ine gore ayarlayin ve gerekirse asagidaki govdeyi
 * saglayicinizin dokumantasyonuna gore uyarlayin.
 */
export async function sendSms(to: string, message: string): Promise<SendResult> {
  if (!env.SMS_PROVIDER_URL) {
    logger.warn({ to }, "SMS saglayicisi yapilandirilmadigi icin SMS gonderilemedi (SMS_PROVIDER_URL bos).");
    return { sent: false, reason: "SMS saglayicisi yapilandirilmamis." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(env.SMS_PROVIDER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(env.SMS_PROVIDER_API_KEY ? { Authorization: `Bearer ${env.SMS_PROVIDER_API_KEY}` } : {}),
      },
      body: JSON.stringify({ to, message, sender: env.SMS_SENDER_ID }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ to, status: res.status, body }, "SMS saglayicisi hata dondurdu.");
      return { sent: false, reason: `SMS saglayicisi HTTP ${res.status} dondurdu.` };
    }
    return { sent: true };
  } catch (err) {
    logger.error({ err, to }, "SMS gonderimi basarisiz.");
    return { sent: false, reason: err instanceof Error ? err.message : "Bilinmeyen hata." };
  } finally {
    clearTimeout(timeout);
  }
}
