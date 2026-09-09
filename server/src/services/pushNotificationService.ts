import { db } from "../db/index.js";
import { isFcmConfigured, sendFcmMessage } from "../utils/fcmClient.js";
import { logger } from "../utils/logger.js";
import type { DevicePushTokenRow } from "../db/types.js";

/**
 * Kritik alarm mobil push bildirimi - mevcut e-posta/SMS/webhook kanallarina (bkz.
 * notificationService.ts, alarmService.ts notifyCriticalAlarm) EK bir kanal. Bir
 * kullanicinin birden fazla cihazi olabilir (bkz. device_push_tokens) - hepsine
 * gonderilir. FCM_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY ayarlanmamissa (varsayilan)
 * sessizce hicbir sey yapmaz - diger kanallari etkilemez.
 */

export function isPushNotificationEnabled(): boolean {
  return isFcmConfigured();
}

export function registerDeviceToken(userId: number, token: string, platform: string): void {
  db.prepare(
    `INSERT INTO device_push_tokens (user_id, token, platform) VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform`
  ).run(userId, token, platform);
}

export function unregisterDeviceToken(userId: number, token: string): void {
  db.prepare("DELETE FROM device_push_tokens WHERE user_id = ? AND token = ?").run(userId, token);
}

function pruneToken(token: string): void {
  db.prepare("DELETE FROM device_push_tokens WHERE token = ?").run(token);
}

/** Bir kullanicinin KAYITLI TUM cihazlarina gonderir; gecersiz bulunan token'lar veritabanindan silinir. */
export async function sendPushToUser(userId: number, title: string, body: string, data?: Record<string, string>): Promise<void> {
  if (!isFcmConfigured()) return;

  const tokens = db.prepare<[number], DevicePushTokenRow>("SELECT * FROM device_push_tokens WHERE user_id = ?").all(userId);
  if (tokens.length === 0) return;

  await Promise.all(
    tokens.map(async (row) => {
      const result = await sendFcmMessage(row.token, title, body, data);
      if (!result.success && result.invalidToken) {
        pruneToken(row.token);
        logger.info({ userId, tokenId: row.id }, "Gecersiz push token silindi.");
      }
    })
  );
}
