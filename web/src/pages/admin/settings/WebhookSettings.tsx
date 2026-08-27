import { useEffect, useState } from "react";
import { api, ApiError } from "../../../shared/api";
import { useEffectiveStationId } from "../../../shared/useEffectiveStation";
import StatusToggle from "./StatusToggle";

interface WebhookConfig {
  enabled: boolean;
  url: string | null;
  secretSet: boolean;
  secretMasked: string | null;
}

export default function WebhookSettings() {
  const stationId = useEffectiveStationId();
  const [config, setConfig] = useState<WebhookConfig | null>(null);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    if (stationId === null) return;
    api.get<{ config: WebhookConfig }>("/api/settings/webhook").then((res) => setConfig(res.config));
  }
  useEffect(load, [stationId]);

  async function update(patch: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      await api.patch("/api/settings/webhook", patch);
      setSavedMsg("Webhook ayarları güncellendi.");
      setUrl("");
      setSecret("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Webhook ayarları güncellenemedi.");
    } finally {
      setSaving(false);
    }
  }

  if (!config) return null;

  return (
    <div className="settings-page">
      <div className="card settings-card">
        <div className="card-head">
          <h3>Kritik Alarm Webhook</h3>
          <StatusToggle checked={config.enabled} disabled={saving} onChange={() => update({ enabled: !config.enabled })} />
        </div>
        <p className="hint-text card-desc">
          Kritik bir alarm oluştuğunda (ve cevapsız kalıp hatırlatma/yükseltme aşamasına geçtiğinde), e-posta/SMS'e
          ek olarak bu URL'ye JSON gövdeli bir HTTP POST isteği gönderilir — kendi SIEM/izleme aracınızı bağlamak
          için. Bir imzalama anahtarı (secret) girerseniz, istek <code>X-Yakit-Signature</code> başlığında
          HMAC-SHA256 imzasıyla gönderilir; alıcı taraf isteğin gerçekten bu sistemden geldiğini bu şekilde
          doğrulayabilir.
        </p>

        <div className="field-grid">
          <div>
            <label>Webhook URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={config.url ?? "https://ornek.com/webhooks/yakit-alarm"}
            />
          </div>
          <div>
            <label>İmzalama Anahtarı (secret) {config.secretSet && <span className="hint-text">(kayıtlı: {config.secretMasked})</span>}</label>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={config.secretSet ? "Değiştirmek için yeni değer girin" : "İsteğe bağlı"}
            />
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}
        {savedMsg && <p className="success-text">{savedMsg}</p>}

        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <div className="spacer" />
          <button
            className="primary"
            disabled={saving || (!url.trim() && !secret.trim())}
            onClick={() => update({ url: url.trim() || undefined, secret: secret.trim() || undefined })}
          >
            Kaydet
          </button>
        </div>
      </div>
    </div>
  );
}
