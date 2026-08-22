import { useEffect, useState } from "react";
import { api, ApiError } from "../../../shared/api";
import { useEffectiveStationId } from "../../../shared/useEffectiveStation";
import StatusToggle from "./StatusToggle";

interface PaymentConfig {
  enabled: boolean;
  environment: "sandbox" | "production";
  apiKeySet: boolean;
  secretKeySet: boolean;
  apiKeyMasked: string | null;
  secretKeyMasked: string | null;
  publicApiBaseUrlConfigured: boolean;
  publicApiBaseUrl: string | null;
}

export default function PaymentSettings() {
  const stationId = useEffectiveStationId();
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    if (stationId === null) return;
    api.get<{ config: PaymentConfig }>("/api/settings/payment").then((res) => setConfig(res.config));
  }
  useEffect(load, [stationId]);

  async function update(patch: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      await api.patch("/api/settings/payment", patch);
      setSavedMsg("Ödeme ayarları güncellendi.");
      setApiKey("");
      setSecretKey("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ödeme ayarları güncellenemedi.");
    } finally {
      setSaving(false);
    }
  }

  if (!config) return null;

  return (
    <div className="settings-page">
      <div className="card settings-card">
        <div className="card-head">
          <h3>Ödeme Ayarları (iyzico)</h3>
          <StatusToggle checked={config.enabled} disabled={saving} onChange={() => update({ enabled: !config.enabled })} />
        </div>
        <p className="hint-text card-desc">
          Kiosk'ta kart bilgisi toplanmaz; müşteri iyzico'nun barındırdığı güvenli ödeme formuna yönlendirilir. Bu
          gerçek bir ödeme altyapısı entegrasyonudur — test için kendi iyzico mağaza hesabınızın API anahtarlarına
          ihtiyacınız vardır.
        </p>

        <label>Ortam</label>
        <select value={config.environment} disabled={saving} onChange={(e) => update({ environment: e.target.value })}>
          <option value="sandbox">Sandbox (test)</option>
          <option value="production">Production (canlı)</option>
        </select>

        <div className="field-grid">
          <div>
            <label>API Anahtarı {config.apiKeySet && <span className="hint-text">(kayıtlı: {config.apiKeyMasked})</span>}</label>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={config.apiKeySet ? "Değiştirmek için yeni değer girin" : "iyzico API anahtarı"}
            />
          </div>
          <div>
            <label>Secret Anahtar {config.secretKeySet && <span className="hint-text">(kayıtlı: {config.secretKeyMasked})</span>}</label>
            <input
              type="password"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder={config.secretKeySet ? "Değiştirmek için yeni değer girin" : "iyzico secret anahtarı"}
            />
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}
        {savedMsg && <p className="success-text">{savedMsg}</p>}

        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <div className="spacer" />
          <button
            className="primary"
            disabled={saving || (!apiKey.trim() && !secretKey.trim())}
            onClick={() => update({ apiKey: apiKey.trim() || undefined, secretKey: secretKey.trim() || undefined })}
          >
            Anahtarları Kaydet
          </button>
        </div>

        <div className="card-divider">
          {config.publicApiBaseUrlConfigured ? (
            <p className="hint-text">
              Geri bildirim (callback) adresi: <code>{config.publicApiBaseUrl}/api/kiosk/transactions/:id/iyzico/callback</code>
            </p>
          ) : (
            <p className="error-text">
              Sunucuda <code>PUBLIC_API_BASE_URL</code> tanımlanmamış. iyzico ödeme sonucunu bu sunucuya bildiremez;
              iyzico ödemesi bu ayar olmadan çalışmaz. Sunucunuzun herkese açık (localhost olmayan) adresini
              .env dosyasına ekleyin.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
