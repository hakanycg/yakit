import type { UserRow } from "../db/types.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { decryptSecret, encryptSecret } from "../utils/secretsCrypto.js";

export type InvoiceEnvironment = "sandbox" | "production";

export interface InvoiceConfig {
  enabled: boolean;
  environment: InvoiceEnvironment;
  username: string | null;
  password: string | null;
  companyVkn: string | null;
  companyTitle: string | null;
  companyTaxOffice: string | null;
  companyAddress: string | null;
  companyCity: string | null;
  companyDistrict: string | null;
}

// Uyumsoft'un gercek e-Fatura/e-Arsiv REST entegrasyon adresleri (BasicIntegrationApi).
const UYUMSOFT_BASE_URLS: Record<InvoiceEnvironment, string> = {
  sandbox: "https://efatura-test.uyumsoft.com.tr",
  production: "https://efatura.uyumsoft.com.tr",
};

export function uyumsoftBaseUrl(environment: InvoiceEnvironment): string {
  return UYUMSOFT_BASE_URLS[environment];
}

export function getInvoiceConfig(stationId: number): InvoiceConfig {
  const environmentRaw = getSetting(stationId, "invoice_environment");
  return {
    enabled: getSetting(stationId, "invoice_enabled") === "true",
    environment: environmentRaw === "production" ? "production" : "sandbox",
    username: getSetting(stationId, "invoice_username"),
    password: decryptSecret(getSetting(stationId, "invoice_password")),
    companyVkn: getSetting(stationId, "invoice_company_vkn"),
    companyTitle: getSetting(stationId, "invoice_company_title"),
    companyTaxOffice: getSetting(stationId, "invoice_company_tax_office"),
    companyAddress: getSetting(stationId, "invoice_company_address"),
    companyCity: getSetting(stationId, "invoice_company_city"),
    companyDistrict: getSetting(stationId, "invoice_company_district"),
  };
}

export interface InvoiceConfigInput {
  enabled?: boolean;
  environment?: InvoiceEnvironment;
  username?: string;
  password?: string;
  companyVkn?: string;
  companyTitle?: string;
  companyTaxOffice?: string;
  companyAddress?: string;
  companyCity?: string;
  companyDistrict?: string;
}

const STRING_FIELD_KEYS: Record<keyof Omit<InvoiceConfigInput, "enabled" | "environment">, string> = {
  username: "invoice_username",
  password: "invoice_password",
  companyVkn: "invoice_company_vkn",
  companyTitle: "invoice_company_title",
  companyTaxOffice: "invoice_company_tax_office",
  companyAddress: "invoice_company_address",
  companyCity: "invoice_company_city",
  companyDistrict: "invoice_company_district",
};

export function setInvoiceConfig(stationId: number, input: InvoiceConfigInput, actor: UserRow | null): void {
  if (input.enabled !== undefined) setSetting(stationId, "invoice_enabled", String(input.enabled), actor);
  if (input.environment !== undefined) setSetting(stationId, "invoice_environment", input.environment, actor);
  for (const [field, key] of Object.entries(STRING_FIELD_KEYS) as [keyof typeof STRING_FIELD_KEYS, string][]) {
    const value = input[field];
    if (value === undefined || value === "") continue;
    setSetting(stationId, key, field === "password" ? encryptSecret(value) : value, actor);
  }
}

function mask(secret: string | null): string | null {
  if (!secret) return null;
  if (secret.length <= 4) return "****";
  return `${"*".repeat(Math.max(secret.length - 4, 0))}${secret.slice(-4)}`;
}

/** Istemciye donerken sifre tamami degil, sadece son 4 karakteri gosterilir. */
export function serializeInvoiceConfig(config: InvoiceConfig) {
  return {
    enabled: config.enabled,
    environment: config.environment,
    usernameSet: !!config.username,
    username: config.username,
    passwordSet: !!config.password,
    passwordMasked: mask(config.password),
    companyVkn: config.companyVkn,
    companyTitle: config.companyTitle,
    companyTaxOffice: config.companyTaxOffice,
    companyAddress: config.companyAddress,
    companyCity: config.companyCity,
    companyDistrict: config.companyDistrict,
  };
}

/**
 * Bir istasyonda gercek e-Fatura/e-Arsiv/E-Irsaliye olusturmak icin gerekli tum bilgilerin
 * girilip girilmedigini kontrol eder. Bu ayni Uyumsoft hesap bilgileri hem fatura hem de
 * irsaliye olusturmak icin kullanildigindan (invoiceService.ts, waybillService.ts) kontrol
 * ve mesajlar belgeye ozel degil, saglayici baglantisina ozeldir.
 */
export function isInvoiceReady(stationId: number): { ready: boolean; reason?: string } {
  const config = getInvoiceConfig(stationId);
  if (!config.enabled) return { ready: false, reason: "Uyumsoft e-belge entegrasyonu bu istasyon icin devre disi." };
  if (!config.username || !config.password) {
    return { ready: false, reason: "E-belge saglayicisi (Uyumsoft) kullanici adi/sifresi tanimlanmamis." };
  }
  if (!config.companyVkn || !config.companyTitle) {
    return { ready: false, reason: "Sirket VKN/unvan bilgisi eksik." };
  }
  return { ready: true };
}
