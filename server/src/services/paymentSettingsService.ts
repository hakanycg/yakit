import type { UserRow } from "../db/types.js";
import { getSetting, setSetting } from "./fuelSyncService.js";
import { env } from "../config.js";

export type IyzicoEnvironment = "sandbox" | "production";

export interface IyzicoConfig {
  enabled: boolean;
  environment: IyzicoEnvironment;
  apiKey: string | null;
  secretKey: string | null;
}

const IYZICO_BASE_URLS: Record<IyzicoEnvironment, string> = {
  sandbox: "https://sandbox-api.iyzipay.com",
  production: "https://api.iyzipay.com",
};

export function iyzicoBaseUrl(environment: IyzicoEnvironment): string {
  return IYZICO_BASE_URLS[environment];
}

export function getIyzicoConfig(stationId: number): IyzicoConfig {
  const enabled = getSetting(stationId, "iyzico_enabled") === "true";
  const environmentRaw = getSetting(stationId, "iyzico_environment");
  const environment: IyzicoEnvironment = environmentRaw === "production" ? "production" : "sandbox";
  const apiKey = getSetting(stationId, "iyzico_api_key");
  const secretKey = getSetting(stationId, "iyzico_secret_key");
  return { enabled, environment, apiKey, secretKey };
}

export interface IyzicoConfigInput {
  enabled?: boolean;
  environment?: IyzicoEnvironment;
  apiKey?: string;
  secretKey?: string;
}

export function setIyzicoConfig(stationId: number, input: IyzicoConfigInput, actor: UserRow | null): void {
  if (input.enabled !== undefined) setSetting(stationId, "iyzico_enabled", String(input.enabled), actor);
  if (input.environment !== undefined) setSetting(stationId, "iyzico_environment", input.environment, actor);
  if (input.apiKey !== undefined && input.apiKey !== "") setSetting(stationId, "iyzico_api_key", input.apiKey, actor);
  if (input.secretKey !== undefined && input.secretKey !== "") setSetting(stationId, "iyzico_secret_key", input.secretKey, actor);
}

function mask(secret: string | null): string | null {
  if (!secret) return null;
  if (secret.length <= 4) return "****";
  return `${"*".repeat(Math.max(secret.length - 4, 0))}${secret.slice(-4)}`;
}

/** Istemciye donerken API anahtarlarinin tamami degil, sadece son 4 karakteri gosterilir. */
export function serializeIyzicoConfig(config: IyzicoConfig) {
  return {
    enabled: config.enabled,
    environment: config.environment,
    apiKeySet: !!config.apiKey,
    secretKeySet: !!config.secretKey,
    apiKeyMasked: mask(config.apiKey),
    secretKeyMasked: mask(config.secretKey),
    publicApiBaseUrlConfigured: !!env.PUBLIC_API_BASE_URL,
    publicApiBaseUrl: env.PUBLIC_API_BASE_URL ?? null,
  };
}

/** Bir istasyonda iyzico ile gercek odeme almak icin gerekli tum sartlarin saglanip saglanmadigini kontrol eder. */
export function isIyzicoReady(stationId: number): { ready: boolean; reason?: string } {
  const config = getIyzicoConfig(stationId);
  if (!config.enabled) return { ready: false, reason: "iyzico entegrasyonu bu istasyon icin devre disi." };
  if (!config.apiKey || !config.secretKey) return { ready: false, reason: "iyzico API anahtarlari eksik." };
  if (!env.PUBLIC_API_BASE_URL) {
    return {
      ready: false,
      reason: "Sunucunun herkese acik adresi (PUBLIC_API_BASE_URL) tanimlanmamis; iyzico odeme sonucunu bildiremez.",
    };
  }
  return { ready: true };
}
