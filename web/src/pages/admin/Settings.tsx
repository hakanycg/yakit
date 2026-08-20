import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { FUEL_LABEL } from "../../shared/format";
import type { FuelPrice } from "../../shared/types";

export default function Settings() {
  const stationId = useEffectiveStationId();
  const [prices, setPrices] = useState<FuelPrice[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  function load() {
    if (stationId === null) return;
    api.get<{ fuelPrices: FuelPrice[] }>("/api/settings/fuel-prices").then((res) => setPrices(res.fuelPrices));
  }
  useEffect(load, [stationId]);

  async function save(fuelType: string) {
    const raw = edits[fuelType];
    const value = Number(raw);
    setError(null);
    setSavedMsg(null);
    if (!raw || Number.isNaN(value) || value <= 0) {
      setError("Gecerli bir fiyat giriniz.");
      return;
    }
    try {
      await api.patch(`/api/settings/fuel-prices/${fuelType}`, { pricePerLiter: value });
      setSavedMsg(`${FUEL_LABEL[fuelType] ?? fuelType} fiyati guncellendi.`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Guncelleme basarisiz.");
    }
  }

  return (
    <div>
      <h2>Ayarlar</h2>
      <div className="card" style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>Yakit Fiyatlari</h3>
        {error && <p className="error-text">{error}</p>}
        {savedMsg && <p className="hint-text" style={{ color: "#4ade80" }}>{savedMsg}</p>}
        {prices.map((p) => (
          <div key={p.fuelType} className="toolbar">
            <span style={{ width: 140 }}>{p.label}</span>
            <input
              type="number"
              step="0.01"
              min="0"
              defaultValue={p.pricePerLiter}
              onChange={(e) => setEdits((prev) => ({ ...prev, [p.fuelType]: e.target.value }))}
              style={{ maxWidth: 140 }}
            />
            <span className="hint-text">TL / litre</span>
            <div className="spacer" />
            <button onClick={() => save(p.fuelType)}>Kaydet</button>
          </div>
        ))}
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
      </div>

      <PaymentSettingsCard />
      <LoyaltyConfigCard />
      <InvoiceSettingsCard />
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
      setSavedMsg("Sadakat ayarlari guncellendi.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ayar guncellenemedi.");
    } finally {
      setSaving(false);
    }
  }

  if (!config) return null;

  return (
    <div className="card" style={{ maxWidth: 560, marginTop: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>Sadakat / Puan Sistemi</h3>
      <p className="hint-text">
        Aktif oldugunda musteriler her dolumda plaka bazinda puan kazanir; kiosk'ta bir sonraki dolumda bu puanlari
        indirim olarak kullanabilirler.
      </p>

      <label>Durum</label>
      <div className="toolbar">
        <button className={config.enabled ? "success" : ""} disabled={saving} onClick={() => update({ enabled: !config.enabled })}>
          {config.enabled ? "Aktif (kapatmak icin tikla)" : "Pasif (acmak icin tikla)"}
        </button>
      </div>

      <label>Litre basina kazanilan puan</label>
      <input type="number" min={0} step={0.1} value={pointsPerLiter} onChange={(e) => setPointsPerLiter(e.target.value)} style={{ maxWidth: 160 }} />

      <label>1 puanin TL degeri (kullanildiginda)</label>
      <input type="number" min={0} step={0.01} value={pointValueTry} onChange={(e) => setPointValueTry(e.target.value)} style={{ maxWidth: 160 }} />

      {error && <p className="error-text">{error}</p>}
      {savedMsg && <p className="hint-text" style={{ color: "#4ade80" }}>{savedMsg}</p>}

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
      setSavedMsg("Odeme ayarlari guncellendi.");
      setApiKey("");
      setSecretKey("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Odeme ayarlari guncellenemedi.");
    } finally {
      setSaving(false);
    }
  }

  if (!config) return null;

  return (
    <div className="card" style={{ maxWidth: 560, marginTop: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>Odeme Ayarlari (iyzico)</h3>
      <p className="hint-text">
        Kiosk'ta kart bilgisi toplanmaz; musteri iyzico'nun barindirdigi guvenli odeme formuna yonlendirilir. Bu
        gercek bir odeme altyapisi entegrasyonudur — test icin kendi iyzico magaza hesabinizin API anahtarlarina
        ihtiyaciniz vardir.
      </p>

      <label>Durum</label>
      <div className="toolbar">
        <button
          className={config.enabled ? "success" : ""}
          disabled={saving}
          onClick={() => update({ enabled: !config.enabled })}
        >
          {config.enabled ? "Aktif (kapatmak icin tikla)" : "Pasif (acmak icin tikla)"}
        </button>
      </div>

      <label>Ortam</label>
      <select value={config.environment} disabled={saving} onChange={(e) => update({ environment: e.target.value })}>
        <option value="sandbox">Sandbox (test)</option>
        <option value="production">Production (canli)</option>
      </select>

      <label>API Anahtari {config.apiKeySet && <span className="hint-text">(kayitli: {config.apiKeyMasked})</span>}</label>
      <input
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={config.apiKeySet ? "Degistirmek icin yeni deger girin" : "iyzico API anahtari"}
      />

      <label>Secret Anahtar {config.secretKeySet && <span className="hint-text">(kayitli: {config.secretKeyMasked})</span>}</label>
      <input
        type="password"
        value={secretKey}
        onChange={(e) => setSecretKey(e.target.value)}
        placeholder={config.secretKeySet ? "Degistirmek icin yeni deger girin" : "iyzico secret anahtari"}
      />

      {error && <p className="error-text">{error}</p>}
      {savedMsg && <p className="hint-text" style={{ color: "#4ade80" }}>{savedMsg}</p>}

      <div className="toolbar" style={{ marginTop: "0.75rem" }}>
        <div className="spacer" />
        <button
          className="primary"
          disabled={saving || (!apiKey.trim() && !secretKey.trim())}
          onClick={() => update({ apiKey: apiKey.trim() || undefined, secretKey: secretKey.trim() || undefined })}
        >
          Anahtarlari Kaydet
        </button>
      </div>

      <div style={{ marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
        {config.publicApiBaseUrlConfigured ? (
          <p className="hint-text">
            Geri bildirim (callback) adresi: <code>{config.publicApiBaseUrl}/api/kiosk/transactions/:id/iyzico/callback</code>
          </p>
        ) : (
          <p className="error-text">
            Sunucuda <code>PUBLIC_API_BASE_URL</code> tanimlanmamis. iyzico odeme sonucunu bu sunucuya bildiremez;
            iyzico odemesi bu ayar olmadan calismaz. Sunucunuzun herkese acik (localhost olmayan) adresini
            .env dosyasina ekleyin.
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
      setSavedMsg("E-fatura ayarlari guncellendi.");
      setUsername("");
      setPassword("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "E-fatura ayarlari guncellenemedi.");
    } finally {
      setSaving(false);
    }
  }

  if (!config) return null;

  return (
    <div className="card" style={{ maxWidth: 560, marginTop: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>Fatura / Irsaliye Ayarlari (E-Fatura, e-Arsiv, E-Irsaliye)</h3>
      <p className="hint-text">
        Tamamlanan islemler icin e-Fatura/e-Arsiv, yakit teslimatlari icin ise E-Irsaliye olusturmak uzere ayni
        gercek Uyumsoft entegrasyon hesabi kullanilir (Yakit Stoku sayfasindaki "E-Irsaliye Olustur" butonu buradaki
        bilgileri kullanir). Bu bir simulasyon degildir — kendi Uyumsoft musteri hesabinizin kullanici adi/sifresini
        ve sirket vergi bilgilerinizi girmeden ne fatura ne de irsaliye kesilebilir.
      </p>

      <label>Durum</label>
      <div className="toolbar">
        <button className={config.enabled ? "success" : ""} disabled={saving} onClick={() => update({ enabled: !config.enabled })}>
          {config.enabled ? "Aktif (kapatmak icin tikla)" : "Pasif (acmak icin tikla)"}
        </button>
      </div>

      <label>Ortam</label>
      <select value={config.environment} disabled={saving} onChange={(e) => update({ environment: e.target.value })}>
        <option value="sandbox">Sandbox (test)</option>
        <option value="production">Production (canli)</option>
      </select>

      <label>Uyumsoft Kullanici Adi {config.usernameSet && <span className="hint-text">(kayitli: {config.username})</span>}</label>
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={config.usernameSet ? "Degistirmek icin yeni deger girin" : "Uyumsoft kullanici adi"}
      />

      <label>Uyumsoft Sifre {config.passwordSet && <span className="hint-text">(kayitli: {config.passwordMasked})</span>}</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={config.passwordSet ? "Degistirmek icin yeni deger girin" : "Uyumsoft sifresi"}
      />

      <div className="toolbar" style={{ marginTop: "0.5rem" }}>
        <div className="spacer" />
        <button
          className="primary"
          disabled={saving || (!username.trim() && !password.trim())}
          onClick={() => update({ username: username.trim() || undefined, password: password.trim() || undefined })}
        >
          Kullanici Bilgilerini Kaydet
        </button>
      </div>

      <div style={{ marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
        <label>Sirket VKN</label>
        <input value={company.companyVkn} onChange={(e) => setCompany((p) => ({ ...p, companyVkn: e.target.value }))} placeholder="10 haneli vergi kimlik no" />

        <label>Sirket Unvani</label>
        <input value={company.companyTitle} onChange={(e) => setCompany((p) => ({ ...p, companyTitle: e.target.value }))} placeholder="Resmi sirket unvani" />

        <label>Vergi Dairesi</label>
        <input value={company.companyTaxOffice} onChange={(e) => setCompany((p) => ({ ...p, companyTaxOffice: e.target.value }))} />

        <label>Adres</label>
        <input value={company.companyAddress} onChange={(e) => setCompany((p) => ({ ...p, companyAddress: e.target.value }))} />

        <div className="toolbar">
          <div>
            <label>Il</label>
            <input value={company.companyCity} onChange={(e) => setCompany((p) => ({ ...p, companyCity: e.target.value }))} style={{ maxWidth: 160 }} />
          </div>
          <div>
            <label>Ilce</label>
            <input value={company.companyDistrict} onChange={(e) => setCompany((p) => ({ ...p, companyDistrict: e.target.value }))} style={{ maxWidth: 160 }} />
          </div>
        </div>

        <div className="toolbar" style={{ marginTop: "0.5rem" }}>
          <div className="spacer" />
          <button className="primary" disabled={saving} onClick={() => update(company)}>
            Sirket Bilgilerini Kaydet
          </button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {savedMsg && <p className="hint-text" style={{ color: "#4ade80" }}>{savedMsg}</p>}
    </div>
  );
}
