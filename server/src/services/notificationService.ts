import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";
import { maskContact } from "../utils/maskPii.js";

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

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/** SMTP yapilandirilmamissa sessizce (hata firlatmadan) atlanir; bu, ozelligin gelistirme ortaminda kirilmasini onler. */
export async function sendEmail(to: string, subject: string, text: string, html?: string, attachments?: EmailAttachment[]): Promise<SendResult> {
  const t = getTransporter();
  if (!t) {
    logger.warn({ to: maskContact(to), subject }, "SMTP yapilandirilmadigi icin e-posta gonderilemedi (SMTP_HOST bos).");
    return { sent: false, reason: "SMTP yapilandirilmamis." };
  }
  try {
    await t.sendMail({ from: env.SMTP_FROM, to, subject, text, html, attachments });
    return { sent: true };
  } catch (err) {
    logger.error({ err, to: maskContact(to), subject }, "E-posta gonderimi basarisiz.");
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
    logger.warn({ to: maskContact(to) }, "SMS saglayicisi yapilandirilmadigi icin SMS gonderilemedi (SMS_PROVIDER_URL bos).");
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
      logger.error({ to: maskContact(to), status: res.status, body }, "SMS saglayicisi hata dondurdu.");
      return { sent: false, reason: `SMS saglayicisi HTTP ${res.status} dondurdu.` };
    }
    return { sent: true };
  } catch (err) {
    logger.error({ err, to: maskContact(to) }, "SMS gonderimi basarisiz.");
    return { sent: false, reason: err instanceof Error ? err.message : "Bilinmeyen hata." };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Genel amacli webhook bildirimi (bkz. webhookSettingsService.ts, alarmService.ts).
 *
 * E-posta/SMS'in aksine bir "saglayici" degil, istasyonun KENDI belirledigi bir
 * URL'dir (ör. bir SIEM/ops aracinin webhook ucu) - bu yuzden `secret` verilmisse
 * govde HMAC-SHA256 ile imzalanip `X-Yakit-Signature` basliginda gonderilir: alici
 * taraf, istegin gercekten bu sistemden geldigini (ve yolda degistirilmedigini)
 * dogrulayabilsin diye. Bu, iyzico'nun bize gonderdigi callback'i BIZIM dogrulama
 * seklimizin (iyzicoService.ts verifySignature) TERSI - burada BIZ imzaliyoruz.
 */
/**
 * IPv4/IPv6 adresi yerel/ozel/rezerve bir araliga mi dusuyor?
 *
 * Webhook URL'si istasyonun KENDI belirledigi bir hedef oldugundan (bkz. sendWebhook
 * yorumu) SSRF riski tasir: sunucu, yapilandirilan URL'ye korlemesine POST atar.
 * Buradaki liste tam bir IANA rezerve blok listesi degil, pratikte SSRF'de
 * hedeflenen ana araliklardir (loopback, RFC1918 ozel aglar, link-local, CGNAT,
 * multicast/rezerve).
 */
function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === "::" || lower === "::1" || lower.startsWith("fe80") || lower.startsWith("fec0") || lower.startsWith("ff");
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/**
 * Hedefi fetch'ten ONCE dogrular: yalnizca http/https, ve host (literal IP ya da
 * DNS'ten cozulen HER adres) yerel/ozel bir araliga dusmemeli. Bu, ayarlarda
 * `z.string().url()`'nin izin verdigi ama sunucunun kendi ic agina (ya da bulut
 * metadata ucuna) istek atmasina yol acabilecek bir URL'yi calisma zamaninda yakalar.
 */
async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Webhook yalnizca http/https destekler.");
  }
  let host = parsed.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error("Webhook URL'si yerel/ozel aglara isaret edemez.");
    return;
  }
  const records = await lookup(host, { all: true });
  if (records.some(({ address }) => isBlockedIp(address))) {
    throw new Error("Webhook URL'si yerel/ozel aglara isaret edemez.");
  }
}

export async function sendWebhook(url: string, payload: unknown, secret: string | null): Promise<SendResult> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-Yakit-Signature"] = createHmac("sha256", secret).update(body).digest("hex");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    await assertSafeWebhookUrl(url);
    // redirect: "manual" - aksi halde sunucu, DOGRULANMIS bir hedeften ENGELLENMIS
    // bir ic adrese yonlendiren bir yanita korlemesine uyar ve kontrolu atlatirdi.
    const res = await fetch(url, { method: "POST", redirect: "manual", signal: controller.signal, headers, body });
    if (!res.ok) {
      logger.error({ url, status: res.status }, "Webhook bildirimi saglayicidan hata dondu.");
      return { sent: false, reason: `Webhook HTTP ${res.status} dondurdu.` };
    }
    return { sent: true };
  } catch (err) {
    logger.error({ err, url }, "Webhook bildirimi gonderilemedi.");
    return { sent: false, reason: err instanceof Error ? err.message : "Bilinmeyen hata." };
  } finally {
    clearTimeout(timeout);
  }
}
