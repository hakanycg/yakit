import type { UserRow } from "../db/types.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { decryptSecret, encryptSecret } from "../utils/secretsCrypto.js";
import { sendWebhook } from "./notificationService.js";

/**
 * Kritik alarmlar icin genel amacli webhook bildirimi (bkz. notificationService.ts
 * sendWebhook, alarmService.ts notifyCriticalAlarm).
 *
 * Ayni desende: paymentSettingsService.ts (iyzico) ile birebir ayni - jenerik
 * settings anahtar/deger deposu (settingsStore.ts) kullanilir, hicbir yeni tablo
 * gerekmez, sir alan sifreli saklanir.
 */
export interface WebhookConfig {
  enabled: boolean;
  url: string | null;
  secret: string | null;
}

export function getWebhookConfig(stationId: number): WebhookConfig {
  const enabled = getSetting(stationId, "alarm_webhook_enabled") === "true";
  const url = getSetting(stationId, "alarm_webhook_url");
  const secret = decryptSecret(getSetting(stationId, "alarm_webhook_secret"));
  return { enabled, url, secret };
}

export interface WebhookConfigInput {
  enabled?: boolean;
  url?: string;
  secret?: string;
}

export function setWebhookConfig(stationId: number, input: WebhookConfigInput, actor: UserRow | null): void {
  if (input.enabled !== undefined) setSetting(stationId, "alarm_webhook_enabled", String(input.enabled), actor);
  if (input.url !== undefined && input.url !== "") setSetting(stationId, "alarm_webhook_url", input.url, actor);
  if (input.secret !== undefined && input.secret !== "")
    setSetting(stationId, "alarm_webhook_secret", encryptSecret(input.secret), actor);
}

function mask(secret: string | null): string | null {
  if (!secret) return null;
  if (secret.length <= 4) return "****";
  return `${"*".repeat(Math.max(secret.length - 4, 0))}${secret.slice(-4)}`;
}

/** Istemciye donerken sir tamamen degil, yalnizca son 4 karakteri gosterilir. */
export function serializeWebhookConfig(config: WebhookConfig) {
  return {
    enabled: config.enabled,
    url: config.url,
    secretSet: !!config.secret,
    secretMasked: mask(config.secret),
  };
}

/** Bu istasyonda webhook bildiriminin fiilen calisabilir olup olmadigini kontrol eder. */
export function isWebhookReady(stationId: number): boolean {
  const config = getWebhookConfig(stationId);
  return config.enabled && !!config.url;
}

export type AlarmWebhookEvent = "critical_alarm" | "critical_alarm_reminder" | "critical_alarm_escalated";

/**
 * Bir alarm icin webhook payload'ini TEK yerde uretip gonderir - alarmService.ts
 * (ilk bildirim) ve alarmEscalationService.ts (hatirlatma/yukseltme) BAGIMSIZ iki
 * cagiran olsa da, govde sekli burada tek kaynaktan gelir, iki yerde birbirinden
 * sessizce sapmaz.
 */
export async function dispatchAlarmWebhook(
  stationId: number,
  stationName: string,
  alarm: { id: number; type: string; severity: string; message: string; created_at: string },
  event: AlarmWebhookEvent
): Promise<void> {
  const config = getWebhookConfig(stationId);
  if (!config.enabled || !config.url) return;
  await sendWebhook(
    config.url,
    {
      event,
      stationId,
      stationName,
      alarmId: alarm.id,
      type: alarm.type,
      severity: alarm.severity,
      message: alarm.message,
      createdAt: alarm.created_at,
    },
    config.secret
  );
}
