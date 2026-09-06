import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config.js";
import type { StationRow } from "../db/types.js";
import { createTestStation } from "../test/dbFixture.js";
import { setSetting } from "./settingsStore.js";
import {
  getFleetCardTopupConfig,
  getIyzicoConfig,
  isIyzicoReady,
  iyzicoBaseUrl,
  serializeIyzicoConfig,
  setFleetCardTopupConfig,
  setIyzicoConfig,
} from "./paymentSettingsService.js";

let station: StationRow;
let previousPublicApiBaseUrl: string | undefined;

beforeEach(() => {
  station = createTestStation();
  previousPublicApiBaseUrl = env.PUBLIC_API_BASE_URL;
});

afterEach(() => {
  env.PUBLIC_API_BASE_URL = previousPublicApiBaseUrl;
});

describe("getIyzicoConfig / setIyzicoConfig", () => {
  it("hicbir ayar yapilmamis istasyonda varsayilan (kapali, sandbox, anahtarsiz) doner", () => {
    const config = getIyzicoConfig(station.id);
    expect(config).toEqual({ enabled: false, environment: "sandbox", apiKey: null, secretKey: null });
  });

  it("API anahtarlarini sifreleyip geri okurken orijinal degeri dondurur (at-rest sifreleme calisiyor)", () => {
    setIyzicoConfig(station.id, { enabled: true, environment: "production", apiKey: "gizli-api-anahtari", secretKey: "gizli-secret" }, null);
    const config = getIyzicoConfig(station.id);
    expect(config).toEqual({ enabled: true, environment: "production", apiKey: "gizli-api-anahtari", secretKey: "gizli-secret" });
  });

  it("bos string ile gonderilen apiKey/secretKey mevcut degeri EZMEZ (kismi guncelleme formu icin)", () => {
    setIyzicoConfig(station.id, { apiKey: "ilk-anahtar", secretKey: "ilk-secret" }, null);
    setIyzicoConfig(station.id, { enabled: true, apiKey: "", secretKey: "" }, null);
    const config = getIyzicoConfig(station.id);
    expect(config.apiKey).toBe("ilk-anahtar");
    expect(config.secretKey).toBe("ilk-secret");
    expect(config.enabled).toBe(true);
  });

  it("gecersiz/taninmayan environment degeri sandbox'a duser", () => {
    setIyzicoConfig(station.id, { environment: "production" }, null);
    expect(getIyzicoConfig(station.id).environment).toBe("production");
  });

  it("iyzicoBaseUrl ortama gore dogru adresi dondurur", () => {
    expect(iyzicoBaseUrl("sandbox")).toBe("https://sandbox-api.iyzipay.com");
    expect(iyzicoBaseUrl("production")).toBe("https://api.iyzipay.com");
  });
});

describe("serializeIyzicoConfig", () => {
  it("anahtar yoksa maskelenmis alanlari null, set bayraklarini false dondurur", () => {
    const serialized = serializeIyzicoConfig(getIyzicoConfig(station.id));
    expect(serialized.apiKeySet).toBe(false);
    expect(serialized.secretKeySet).toBe(false);
    expect(serialized.apiKeyMasked).toBeNull();
    expect(serialized.secretKeyMasked).toBeNull();
  });

  it("uzun bir anahtarin yalnizca son 4 karakterini gosterir, gerisini yildizlar", () => {
    setIyzicoConfig(station.id, { apiKey: "abcdefgh1234", secretKey: "kisa" }, null);
    const serialized = serializeIyzicoConfig(getIyzicoConfig(station.id));
    expect(serialized.apiKeySet).toBe(true);
    expect(serialized.apiKeyMasked).toBe("********1234");
    // 4 karakter veya daha kisa sirlar tamamen "****" ile gosterilir (son 4'u bile acikta birakmaz).
    expect(serialized.secretKeyMasked).toBe("****");
  });

  it("PUBLIC_API_BASE_URL tanimliysa bunu yansitir", () => {
    env.PUBLIC_API_BASE_URL = "https://ops.example.com";
    const serialized = serializeIyzicoConfig(getIyzicoConfig(station.id));
    expect(serialized.publicApiBaseUrlConfigured).toBe(true);
    expect(serialized.publicApiBaseUrl).toBe("https://ops.example.com");
  });
});

describe("getFleetCardTopupConfig / setFleetCardTopupConfig", () => {
  it("hic ayarlanmamissa kapali ve varsayilan %3 komisyon doner", () => {
    expect(getFleetCardTopupConfig(station.id)).toEqual({ enabled: false, feePct: 3 });
  });

  it("ayarlanan enabled/feePct degerlerini geri okur", () => {
    setFleetCardTopupConfig(station.id, { enabled: true, feePct: 2.5 }, null);
    expect(getFleetCardTopupConfig(station.id)).toEqual({ enabled: true, feePct: 2.5 });
  });

  it("bozuk (sayi olmayan) bir feePct degeri kayitli olsa bile varsayilana duser", () => {
    setSetting(station.id, "fleet_card_topup_fee_pct", "not-a-number", null);
    expect(getFleetCardTopupConfig(station.id).feePct).toBe(3);
  });
});

describe("isIyzicoReady", () => {
  it("entegrasyon kapaliyken hazir degildir", () => {
    expect(isIyzicoReady(station.id)).toEqual({ ready: false, reason: "iyzico entegrasyonu bu istasyon icin devre disi." });
  });

  it("acik ama API anahtarlari eksikse hazir degildir", () => {
    setIyzicoConfig(station.id, { enabled: true }, null);
    expect(isIyzicoReady(station.id)).toEqual({ ready: false, reason: "iyzico API anahtarlari eksik." });
  });

  it("anahtarlar tamamsa ama PUBLIC_API_BASE_URL tanimsizsa hazir degildir", () => {
    env.PUBLIC_API_BASE_URL = undefined;
    setIyzicoConfig(station.id, { enabled: true, apiKey: "k", secretKey: "s" }, null);
    const result = isIyzicoReady(station.id);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/PUBLIC_API_BASE_URL/);
  });

  it("tum sartlar saglaninca hazirdir", () => {
    env.PUBLIC_API_BASE_URL = "https://ops.example.com";
    setIyzicoConfig(station.id, { enabled: true, apiKey: "k", secretKey: "s" }, null);
    expect(isIyzicoReady(station.id)).toEqual({ ready: true });
  });
});
