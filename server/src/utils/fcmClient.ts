import { createSign } from "node:crypto";
import { env } from "../config.js";
import { logger } from "./logger.js";

/**
 * Firebase Cloud Messaging (FCM) HTTP v1 API'sine dogrudan HTTP ile konusan minimal bir
 * istemci - `firebase-admin` gibi agir bir SDK eklemek yerine, bu projenin diger
 * entegrasyonlarindaki (Uyumsoft e-Fatura/e-Irsaliye, SMS saglayicisi) AYNI ilke: sadece
 * gerekli HTTP cagrisi.
 *
 * FCM v1, eski "server key" (legacy HTTP API) yerine bir SERVIS HESABI (service account)
 * ile OAuth2 erisim tokeni ister - bu token, servis hesabinin ozel anahtariyla RS256
 * imzalanmis bir JWT'nin Google'in token ucuna degistirilmesiyle elde edilir (JWT bearer
 * grant). Google'in resmi kutuphaneleri (google-auth-library) da ayni akisi uygular; burada
 * ayni akis Node'un yerlesik crypto modulu ile elle yazilmistir.
 */

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/** Yalnizca testler icin: modul-seviyesindeki OAuth2 token onbellegini temizler - aksi
 * halde bir testte alinan "gecerli" token, sonraki testin bekledigi fetch cagri sayisini bozar. */
export function _resetFcmTokenCacheForTests(): void {
  cachedToken = null;
}

export function isFcmConfigured(): boolean {
  return !!(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY);
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;

  const clientEmail = env.FCM_CLIENT_EMAIL!;
  // Ortam degiskenlerinde satir sonlari genelde "\n" kacisli metin olarak saklanir -
  // gercek satir sonuna cevrilmezse RSA anahtari PEM olarak ayristirilamaz.
  const privateKey = env.FCM_PRIVATE_KEY!.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey).toString("base64url");
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`FCM OAuth2 token alinamadi (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  // Sure dolmadan biraz once yenilenir (60 sn pay) - tam sinirda calisan bir istegin
  // suresi dolmus bir tokenla basarisiz olmasini onlemek icin.
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.accessToken;
}

export interface FcmSendResult {
  success: boolean;
  /** true ise cihaz tokeni artik gecersiz (uygulama kaldirilmis/izin geri alinmis) - cagiran taraf token'i silmelidir. */
  invalidToken?: boolean;
  error?: string;
}

export async function sendFcmMessage(deviceToken: string, title: string, body: string, data?: Record<string, string>): Promise<FcmSendResult> {
  if (!isFcmConfigured()) return { success: false, error: "FCM yapilandirilmamis." };

  try {
    const accessToken = await getAccessToken();
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token: deviceToken, notification: { title, body }, data } }),
    });
    if (res.ok) return { success: true };

    const errBody = (await res.json().catch(() => null)) as { error?: { status?: string; message?: string } } | null;
    const status = errBody?.error?.status;
    // UNREGISTERED: uygulama kaldirilmis/token yenilenmis. INVALID_ARGUMENT genelde
    // bozuk/artik gecersiz bir token formatidir - ikisi de kalici bir hata, tekrar
    // denemek anlamsizdir; cagiran taraf token'i veritabanindan siler.
    const invalidToken = status === "UNREGISTERED" || status === "INVALID_ARGUMENT" || res.status === 404;
    logger.warn({ status: res.status, fcmStatus: status }, "FCM push bildirimi gonderilemedi.");
    return { success: false, invalidToken, error: errBody?.error?.message ?? `FCM HTTP ${res.status}` };
  } catch (err) {
    logger.error({ err }, "FCM push bildirimi gonderilirken hata olustu.");
    return { success: false, error: err instanceof Error ? err.message : "Bilinmeyen hata." };
  }
}
