import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useAuth } from "../../shared/AuthContext";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { FUEL_LABEL, formatCurrency, formatDateTime } from "../../shared/format";
import type { FuelPrice } from "../../shared/types";

interface ScheduledPriceChange {
  id: number;
  fuelType: string;
  pricePerLiter: number;
  scheduledFor: string;
  status: "pending" | "applied" | "cancelled";
  createdAt: string;
  appliedAt: string | null;
}

function StatusToggle({
  checked,
  disabled,
  onChange,
  activeLabel = "Aktif",
  inactiveLabel = "Pasif",
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  activeLabel?: string;
  inactiveLabel?: string;
}) {
  return (
    <label className={`switch-row${disabled ? " disabled" : ""}`}>
      <span className="switch">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
        <span className="track"><span className="thumb" /></span>
      </span>
      <span className="switch-label">{checked ? activeLabel : inactiveLabel}</span>
    </label>
  );
}

export default function Settings() {
  const stationId = useEffectiveStationId();
  const [prices, setPrices] = useState<FuelPrice[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ScheduledPriceChange[]>([]);
  const [scheduleFuelType, setScheduleFuelType] = useState("");
  const [schedulePrice, setSchedulePrice] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false);

  function load() {
    if (stationId === null) return;
    api.get<{ fuelPrices: FuelPrice[] }>("/api/settings/fuel-prices").then((res) => setPrices(res.fuelPrices));
    api.get<{ schedules: ScheduledPriceChange[] }>("/api/settings/fuel-prices/scheduled").then((res) => setSchedules(res.schedules));
  }
  useEffect(load, [stationId]);

  async function submitSchedule() {
    setScheduleError(null);
    const price = Number(schedulePrice);
    if (!scheduleFuelType || !schedulePrice || Number.isNaN(price) || price <= 0 || !scheduleAt) {
      setScheduleError("Yakıt tipi, fiyat ve tarih/saat gereklidir.");
      return;
    }
    setScheduleSubmitting(true);
    try {
      await api.post("/api/settings/fuel-prices/scheduled", {
        fuelType: scheduleFuelType,
        pricePerLiter: price,
        scheduledFor: new Date(scheduleAt).toISOString(),
      });
      setScheduleFuelType("");
      setSchedulePrice("");
      setScheduleAt("");
      load();
    } catch (err) {
      setScheduleError(err instanceof ApiError ? err.message : "Planlanamadı.");
    } finally {
      setScheduleSubmitting(false);
    }
  }

  async function cancelScheduleRow(id: number) {
    setScheduleError(null);
    try {
      await api.delete(`/api/settings/fuel-prices/scheduled/${id}`);
      load();
    } catch (err) {
      setScheduleError(err instanceof ApiError ? err.message : "İptal edilemedi.");
    }
  }

  const pendingSchedules = schedules.filter((s) => s.status === "pending");

  async function save(fuelType: string) {
    const raw = edits[fuelType];
    const value = Number(raw);
    setError(null);
    setSavedMsg(null);
    if (!raw || Number.isNaN(value) || value <= 0) {
      setError("Geçerli bir fiyat giriniz.");
      return;
    }
    try {
      await api.patch(`/api/settings/fuel-prices/${fuelType}`, { pricePerLiter: value });
      setSavedMsg(`${FUEL_LABEL[fuelType] ?? fuelType} fiyatı güncellendi.`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Güncelleme başarısız.");
    }
  }

  return (
    <div>
      <h2>Ayarlar</h2>
      <p className="hint-text settings-intro">
        İstasyonunuzun yakıt fiyatlarını ve entegrasyonlarını (ödeme, sadakat, fatura/irsaliye) buradan yönetin.
      </p>

      <div className="settings-grid">
        <div className="card settings-card">
          <div className="card-head">
            <h3>Yakıt Fiyatları</h3>
          </div>
          {prices.map((p) => (
            <div key={p.fuelType} className="fuel-price-row">
              <span className="fuel-price-label">{p.label}</span>
              <input
                type="number"
                step="0.01"
                min="0"
                defaultValue={p.pricePerLiter}
                onChange={(e) => setEdits((prev) => ({ ...prev, [p.fuelType]: e.target.value }))}
              />
              <span className="hint-text">TL/L</span>
              <button onClick={() => save(p.fuelType)}>Kaydet</button>
            </div>
          ))}
          {error && <p className="error-text">{error}</p>}
          {savedMsg && <p className="success-text">{savedMsg}</p>}
          <p className="hint-text" style={{ marginTop: "0.75rem" }}>
            Resmi fiyatları elle karşılaştırmak isterseniz:{" "}
            <a
              href="https://lisans.epdk.gov.tr/epvys-web/faces/pages/lisans/petrolBayilik/pompaFiyatlariOzetSorgula.xhtml"
              target="_blank"
              rel="noopener noreferrer"
            >
              EPDK İstasyon Pompa Fiyatları sorgu sayfası
            </a>{" "}
            (il/ilçe/bayi bazında; CAPTCHA korumalı olduğundan otomatik çekilemiyor, elle sorgulanır).
          </p>

          <h4 style={{ marginTop: "1.25rem" }}>Zamanlanmış Fiyat Değişikliği</h4>
          <p className="hint-text">İleri bir tarih/saat belirleyin, o an geldiğinde fiyat otomatik devreye girer.</p>
          <div className="toolbar" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
            <select value={scheduleFuelType} onChange={(e) => setScheduleFuelType(e.target.value)}>
              <option value="">Yakıt tipi seçin</option>
              {prices.map((p) => (
                <option key={p.fuelType} value={p.fuelType}>{p.label}</option>
              ))}
            </select>
            <input type="number" step="0.01" min="0" placeholder="Yeni fiyat (TL/L)" value={schedulePrice} onChange={(e) => setSchedulePrice(e.target.value)} style={{ width: "10rem" }} />
            <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
            <button className="primary" onClick={submitSchedule} disabled={scheduleSubmitting}>
              {scheduleSubmitting ? "Planlanıyor..." : "Planla"}
            </button>
          </div>
          {scheduleError && <p className="error-text">{scheduleError}</p>}

          {pendingSchedules.length > 0 && (
            <table style={{ marginTop: "0.75rem" }}>
              <thead>
                <tr><th>Yakıt</th><th className="numeric">Yeni Fiyat</th><th>Planlanan Zaman</th><th></th></tr>
              </thead>
              <tbody>
                {pendingSchedules.map((s) => (
                  <tr key={s.id}>
                    <td>{FUEL_LABEL[s.fuelType] ?? s.fuelType}</td>
                    <td className="numeric">{formatCurrency(s.pricePerLiter)}</td>
                    <td>{formatDateTime(s.scheduledFor)}</td>
                    <td><button onClick={() => cancelScheduleRow(s.id)}>İptal Et</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <PaymentSettingsCard />
        <LoyaltyConfigCard />
        <ReportEmailCard />
        <InvoiceSettingsCard />
        <StationAgentCard />
      </div>
    </div>
  );
}

interface LoyaltyConfig {
  enabled: boolean;
  pointsPerLiter: number;
  pointValueTry: number;
}

function LoyaltyConfigCard() {
  const stationId = useEffectiveStationId();
  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [pointsPerLiter, setPointsPerLiter] = useState("");
  const [pointValueTry, setPointValueTry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    if (stationId === null) return;
    api.get<{ config: LoyaltyConfig }>("/api/loyalty/config").then((res) => {
      setConfig(res.config);
      setPointsPerLiter(String(res.config.pointsPerLiter));
      setPointValueTry(String(res.config.pointValueTry));
    });
  }
  useEffect(load, [stationId]);

  async function update(patch: Partial<LoyaltyConfig>) {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      await api.patch("/api/loyalty/config", patch);
      setSavedMsg("Sadakat ayarları güncellendi.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ayar güncellenemedi.");
    } finally {
      setSaving(false);
    }
  }

  if (!config) return null;

  return (
    <div className="card settings-card">
      <div className="card-head">
        <h3>Sadakat / Puan Sistemi</h3>
        <StatusToggle checked={config.enabled} disabled={saving} onChange={() => update({ enabled: !config.enabled })} />
      </div>
      <p className="hint-text card-desc">
        Aktif olduğunda müşteriler her dolumda plaka bazında puan kazanır; kiosk'ta bir sonraki dolumda bu puanları
        indirim olarak kullanabilirler.
      </p>

      <div className="field-grid">
        <div>
          <label>Litre başına kazanılan puan</label>
          <input type="number" min={0} step={0.1} value={pointsPerLiter} onChange={(e) => setPointsPerLiter(e.target.value)} />
        </div>
        <div>
          <label>1 puanın TL değeri (kullanıldığında)</label>
          <input type="number" min={0} step={0.01} value={pointValueTry} onChange={(e) => setPointValueTry(e.target.value)} />
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {savedMsg && <p className="success-text">{savedMsg}</p>}

      <div className="toolbar" style={{ marginTop: "0.75rem" }}>
        <div className="spacer" />
        <button
          className="primary"
          disabled={saving}
          onClick={() => update({ pointsPerLiter: Number(pointsPerLiter), pointValueTry: Number(pointValueTry) })}
        >
          Kaydet
        </button>
      </div>
    </div>
  );
}

type ReportEmailFrequency = "none" | "weekly" | "monthly";

function ReportEmailCard() {
  const stationId = useEffectiveStationId();
  const [frequency, setFrequency] = useState<ReportEmailFrequency>("none");
  const [lastSentAt, setLastSentAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    if (stationId === null) return;
    api.get<{ frequency: ReportEmailFrequency; lastSentAt: string | null }>("/api/settings/report-email").then((res) => {
      setFrequency(res.frequency);
      setLastSentAt(res.lastSentAt);
    });
  }
  useEffect(load, [stationId]);

  async function save(value: ReportEmailFrequency) {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      await api.patch("/api/settings/report-email", { frequency: value });
      setSavedMsg("Ayar kaydedildi.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ayar kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card settings-card">
      <div className="card-head">
        <h3>Otomatik Özet Raporu</h3>
      </div>
      <p className="hint-text card-desc">
        Seçilen sıklıkta, istasyonun "İstasyon Yöneticisi" rolündeki (e-posta adresi kayıtlı) kullanıcılarına
        ciro/litre/tahmini kar özeti otomatik e-posta ile gönderilir.
      </p>

      <label>Sıklık</label>
      <select value={frequency} disabled={saving} onChange={(e) => save(e.target.value as ReportEmailFrequency)}>
        <option value="none">Kapalı</option>
        <option value="weekly">Haftalık</option>
        <option value="monthly">Aylık</option>
      </select>

      {lastSentAt && <p className="hint-text" style={{ marginTop: "0.5rem" }}>Son gönderim: {new Date(lastSentAt).toLocaleString("tr-TR")}</p>}
      {error && <p className="error-text">{error}</p>}
      {savedMsg && <p className="success-text">{savedMsg}</p>}
    </div>
  );
}

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

function PaymentSettingsCard() {
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
  );
}

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

function InvoiceSettingsCard() {
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
    <div className="card settings-card card-wide">
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
  );
}

interface SyncStatus {
  lastHeartbeatAt: string | null;
  lastSyncedAt: string | null;
  agentConfigured: boolean;
}

/**
 * Token'i yeniden olusturmak eski token'i aninda gecersiz kilar (istasyondaki
 * ajan tekrar yapilandirilana kadar senkronizasyon duracaktir) - bu yuzden
 * hesabinda 2FA acik olan bir kullanici icin acilir bir pencerede guncel TOTP
 * kodu istenir (bkz. server/src/routes/sync.ts). 2FA'si olmayan kullanicilar
 * icin ayni pencere sadece bir onay adimi olarak gorunur.
 */
function RotateTokenDialog({ requiresTotp, onClose, onRotated }: { requiresTotp: boolean; onClose: () => void; onRotated: (token: string) => void }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{ syncToken: string }>("/api/sync/token/rotate", requiresTotp ? { code: code.trim() } : undefined);
      onRotated(res.syncToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Token yeniden olusturulamadi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
      <div className="card" style={{ width: "min(420px, 92vw)" }}>
        <h3 style={{ marginTop: 0 }}>Senkron Token'ı Yeniden Oluştur</h3>
        <p className="error-text">
          Bu işlem mevcut token'ı anında geçersiz kılar. İstasyondaki ajan, yeni token yapılandırılana kadar
          senkronizasyon yapamaz.
        </p>
        {requiresTotp ? (
          <>
            <label htmlFor="rotate-totp-code">Doğrulayıcı uygulamadaki 6 haneli kod</label>
            <input
              id="rotate-totp-code"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </>
        ) : (
          <p className="hint-text">
            Hesabınızda iki aşamalı doğrulama açık değil, bu yüzden yalnızca onayınız isteniyor. Daha güvenli olması
            için "Hesabım &gt; İki Aşamalı Doğrulama" üzerinden 2FA'yı etkinleştirmenizi öneririz.
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="toolbar" style={{ marginTop: "1.25rem" }}>
          <button onClick={onClose} disabled={submitting}>Vazgeç</button>
          <div className="spacer" />
          <button className="danger" onClick={submit} disabled={submitting || (requiresTotp && code.length !== 6)}>
            {submitting ? "Doğrulanıyor..." : "Evet, Yeniden Oluştur"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StationAgentCard() {
  const { user } = useAuth();
  const stationId = useEffectiveStationId();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);

  function loadStatus() {
    if (stationId === null) return;
    api.get<SyncStatus>("/api/sync/status").then(setStatus).catch(() => setStatus(null));
  }
  useEffect(() => {
    setToken(null);
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId]);

  async function revealToken() {
    setLoadingToken(true);
    setError(null);
    try {
      const res = await api.get<{ syncToken: string }>("/api/sync/token");
      setToken(res.syncToken);
      loadStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Token alınamadı.");
    } finally {
      setLoadingToken(false);
    }
  }

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Panoya kopyalanamadı, elle seçip kopyalayın.");
    }
  }

  if (!status) return null;

  return (
    <div className="card settings-card">
      <div className="card-head">
        <h3>İstasyon Ajanı Kurulumu</h3>
        <span className={`badge ${status.agentConfigured ? "completed" : "info"}`}>
          {status.agentConfigured ? "Bağlı" : "Ajan kurulmadı"}
        </span>
      </div>
      <p className="hint-text card-desc">
        İstasyon ajanı, kiosk bilgisayarında arka planda çalışan ve internet kesintisinde işlemleri yerelde
        kuyruğa alıp bağlantı geri gelince senkronize eden ayrı bir program. Aşağıdaki token'ı ajanın{" "}
        <code>.env</code> dosyasındaki <code>STATION_SYNC_TOKEN</code> alanına girin.
      </p>

      <div className="toolbar" style={{ margin: "0.5rem 0" }}>
        <span className="hint-text">Son heartbeat:</span>
        <strong>{formatDateTime(status.lastHeartbeatAt)}</strong>
        <div className="spacer" />
        <span className="hint-text">Son senkron:</span>
        <strong>{formatDateTime(status.lastSyncedAt)}</strong>
      </div>

      {token ? (
        <div className="toolbar" style={{ flexWrap: "nowrap" }}>
          <code style={{ flex: 1, minWidth: 0, overflowX: "auto", whiteSpace: "nowrap", padding: "0.5rem 0.75rem", background: "var(--panel-2)", borderRadius: "8px" }}>
            {token}
          </code>
          <button onClick={copyToken}>{copied ? "Kopyalandı" : "Kopyala"}</button>
        </div>
      ) : (
        <button onClick={revealToken} disabled={loadingToken}>
          {loadingToken ? "Yükleniyor..." : status.agentConfigured ? "Token'ı Göster" : "Token Oluştur ve Göster"}
        </button>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="card-divider">
        <button onClick={() => setRotateOpen(true)}>Token'ı Yeniden Oluştur</button>
        <p className="hint-text" style={{ marginTop: "0.4rem" }}>
          Token ele geçirilmiş olabileceğini düşünüyorsanız yeniden oluşturun; eski token anında geçersiz olur.
        </p>
      </div>

      {rotateOpen && (
        <RotateTokenDialog
          requiresTotp={!!user?.totpEnabled}
          onClose={() => setRotateOpen(false)}
          onRotated={(newToken) => {
            setToken(newToken);
            setRotateOpen(false);
            loadStatus();
          }}
        />
      )}
    </div>
  );
}
