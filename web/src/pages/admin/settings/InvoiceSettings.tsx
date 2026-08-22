import { useEffect, useState } from "react";
import { api, ApiError } from "../../../shared/api";
import { useEffectiveStationId } from "../../../shared/useEffectiveStation";
import StatusToggle from "./StatusToggle";

interface InvoiceConfig {
  enabled: boolean;
  environment: "sandbox" | "production";
  usernameSet: boolean;
  username: string | null;
  passwordSet: boolean;
  passwordMasked: string | null;
  companyVkn: string | null;
  companyTitle: string | null;
  companyTaxOffice: string | null;
  companyAddress: string | null;
  companyCity: string | null;
  companyDistrict: string | null;
}

export default function InvoiceSettings() {
  const stationId = useEffectiveStationId();
  const [config, setConfig] = useState<InvoiceConfig | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [company, setCompany] = useState({ companyVkn: "", companyTitle: "", companyTaxOffice: "", companyAddress: "", companyCity: "", companyDistrict: "" });
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    if (stationId === null) return;
    api.get<{ config: InvoiceConfig }>("/api/settings/invoice").then((res) => {
      setConfig(res.config);
      setCompany({
        companyVkn: res.config.companyVkn ?? "",
        companyTitle: res.config.companyTitle ?? "",
        companyTaxOffice: res.config.companyTaxOffice ?? "",
        companyAddress: res.config.companyAddress ?? "",
        companyCity: res.config.companyCity ?? "",
        companyDistrict: res.config.companyDistrict ?? "",
      });
    });
  }
  useEffect(load, [stationId]);

  async function update(patch: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      await api.patch("/api/settings/invoice", patch);
      setSavedMsg("E-fatura ayarları güncellendi.");
      setUsername("");
      setPassword("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "E-fatura ayarları güncellenemedi.");
    } finally {
      setSaving(false);
    }
  }

  if (!config) return null;

  return (
    <div className="settings-page">
      <div className="card settings-card">
        <div className="card-head">
          <h3>Fatura / İrsaliye Ayarları (E-Fatura, e-Arşiv, E-İrsaliye)</h3>
          <StatusToggle checked={config.enabled} disabled={saving} onChange={() => update({ enabled: !config.enabled })} />
        </div>
        <p className="hint-text card-desc">
          Tamamlanan işlemler için e-Fatura/e-Arşiv, yakıt teslimatları için ise E-İrsaliye oluşturmak üzere aynı
          gerçek Uyumsoft entegrasyon hesabı kullanılır (Yakıt Stoku sayfasındaki "E-İrsaliye Oluştur" butonu buradaki
          bilgileri kullanır). Bu bir simülasyon değildir — kendi Uyumsoft müşteri hesabınızın kullanıcı adı/şifresini
          ve şirket vergi bilgilerinizi girmeden ne fatura ne de irsaliye kesilebilir.
        </p>

        <div className="field-grid">
          <div>
            <label>Ortam</label>
            <select value={config.environment} disabled={saving} onChange={(e) => update({ environment: e.target.value })}>
              <option value="sandbox">Sandbox (test)</option>
              <option value="production">Production (canlı)</option>
            </select>
          </div>
        </div>

        <div className="field-grid">
          <div>
            <label>Uyumsoft Kullanıcı Adı {config.usernameSet && <span className="hint-text">(kayıtlı: {config.username})</span>}</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={config.usernameSet ? "Değiştirmek için yeni değer girin" : "Uyumsoft kullanıcı adı"}
            />
          </div>
          <div>
            <label>Uyumsoft Şifre {config.passwordSet && <span className="hint-text">(kayıtlı: {config.passwordMasked})</span>}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={config.passwordSet ? "Değiştirmek için yeni değer girin" : "Uyumsoft şifresi"}
            />
          </div>
        </div>

        <div className="toolbar" style={{ marginTop: "0.5rem" }}>
          <div className="spacer" />
          <button
            className="primary"
            disabled={saving || (!username.trim() && !password.trim())}
            onClick={() => update({ username: username.trim() || undefined, password: password.trim() || undefined })}
          >
            Kullanıcı Bilgilerini Kaydet
          </button>
        </div>

        <div className="card-divider">
          <div className="field-grid">
            <div>
              <label>Şirket VKN</label>
              <input value={company.companyVkn} onChange={(e) => setCompany((p) => ({ ...p, companyVkn: e.target.value }))} placeholder="10 haneli vergi kimlik no" />
            </div>
            <div>
              <label>Şirket Unvanı</label>
              <input value={company.companyTitle} onChange={(e) => setCompany((p) => ({ ...p, companyTitle: e.target.value }))} placeholder="Resmi şirket unvanı" />
            </div>
            <div>
              <label>Vergi Dairesi</label>
              <input value={company.companyTaxOffice} onChange={(e) => setCompany((p) => ({ ...p, companyTaxOffice: e.target.value }))} />
            </div>
            <div>
              <label>Adres</label>
              <input value={company.companyAddress} onChange={(e) => setCompany((p) => ({ ...p, companyAddress: e.target.value }))} />
            </div>
            <div>
              <label>İl</label>
              <input value={company.companyCity} onChange={(e) => setCompany((p) => ({ ...p, companyCity: e.target.value }))} />
            </div>
            <div>
              <label>İlçe</label>
              <input value={company.companyDistrict} onChange={(e) => setCompany((p) => ({ ...p, companyDistrict: e.target.value }))} />
            </div>
          </div>

          <div className="toolbar" style={{ marginTop: "0.75rem" }}>
            <div className="spacer" />
            <button className="primary" disabled={saving} onClick={() => update(company)}>
              Şirket Bilgilerini Kaydet
            </button>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}
        {savedMsg && <p className="success-text">{savedMsg}</p>}
      </div>
    </div>
  );
}
