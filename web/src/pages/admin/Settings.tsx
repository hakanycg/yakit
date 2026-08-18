import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { FUEL_LABEL, formatCurrency, formatDateTime } from "../../shared/format";
import type { FuelPrice } from "../../shared/types";

export default function Settings() {
  const [prices, setPrices] = useState<FuelPrice[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  function load() {
    api.get<{ fuelPrices: FuelPrice[] }>("/api/settings/fuel-prices").then((res) => setPrices(res.fuelPrices));
  }
  useEffect(load, []);

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

      <FuelSyncCard onPricesChanged={load} />
    </div>
  );
}

interface FuelSyncConfig {
  enabled: boolean;
  city: string;
  intervalMinutes: number;
}

interface FuelSyncState {
  config: FuelSyncConfig;
  cities: string[];
  lastRunAt: string | null;
  lastStatus: string | null;
  lastSummary: { city?: string; updated?: Record<string, number>; skipped?: string[]; error?: string } | null;
}

const INTERVAL_OPTIONS = [
  { minutes: 60, label: "Her saat" },
  { minutes: 360, label: "6 saatte bir" },
  { minutes: 720, label: "12 saatte bir" },
  { minutes: 1440, label: "Gunde bir kez" },
];

function FuelSyncCard({ onPricesChanged }: { onPricesChanged: () => void }) {
  const [state, setState] = useState<FuelSyncState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  function load() {
    api.get<FuelSyncState>("/api/settings/fuel-sync").then(setState);
  }
  useEffect(load, []);

  async function updateConfig(patch: Partial<FuelSyncConfig>) {
    setSaving(true);
    setError(null);
    try {
      await api.patch("/api/settings/fuel-sync", patch);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ayar guncellenemedi.");
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      await api.post("/api/settings/fuel-sync/run-now");
      load();
      onPricesChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Senkronizasyon basarisiz.");
    } finally {
      setRunning(false);
    }
  }

  if (!state) return null;

  return (
    <div className="card" style={{ maxWidth: 560, marginTop: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>Otomatik Fiyat Guncelleme (Turkiye Piyasasi)</h3>
      <p className="hint-text">
        Ucuncu parti bir kaynaktan (hasanadiguzel.com.tr) sehir bazli yaklasik guncel fiyatlar cekilir. Bu resmi
        (EPDK) bir kaynak degildir; referans amaclidir. LPG verisi bazi sehirlerde bulunmayabilir, bu durumda o
        yakit tipi atlanir.
      </p>

      <label>Durum</label>
      <div className="toolbar">
        <button
          className={state.config.enabled ? "success" : ""}
          disabled={saving}
          onClick={() => updateConfig({ enabled: !state.config.enabled })}
        >
          {state.config.enabled ? "Aktif (kapatmak icin tikla)" : "Pasif (acmak icin tikla)"}
        </button>
      </div>

      <label>Sehir</label>
      <select value={state.config.city} disabled={saving} onChange={(e) => updateConfig({ city: e.target.value })}>
        {state.cities.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>

      <label>Guncelleme sikligi</label>
      <select
        value={state.config.intervalMinutes}
        disabled={saving}
        onChange={(e) => updateConfig({ intervalMinutes: Number(e.target.value) })}
      >
        {INTERVAL_OPTIONS.map((o) => (
          <option key={o.minutes} value={o.minutes}>{o.label}</option>
        ))}
      </select>

      {error && <p className="error-text">{error}</p>}

      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <button onClick={runNow} disabled={running}>{running ? "Cekiliyor..." : "Simdi Guncelle"}</button>
        <div className="spacer" />
        <span className="hint-text">Son calisma: {formatDateTime(state.lastRunAt)}</span>
      </div>

      {state.lastStatus === "error" && state.lastSummary?.error && (
        <p className="error-text">Son deneme basarisiz: {state.lastSummary.error}</p>
      )}
      {state.lastStatus === "success" && state.lastSummary?.updated && (
        <div className="hint-text" style={{ marginTop: "0.5rem" }}>
          <div>{state.lastSummary.city} icin guncellenen fiyatlar:</div>
          <ul style={{ margin: "0.25rem 0 0 1rem" }}>
            {Object.entries(state.lastSummary.updated).map(([fuelType, price]) => (
              <li key={fuelType}>{FUEL_LABEL[fuelType] ?? fuelType}: {formatCurrency(price)}</li>
            ))}
          </ul>
          {state.lastSummary.skipped && state.lastSummary.skipped.length > 0 && (
            <div>Veri bulunamadigi icin atlandi: {state.lastSummary.skipped.map((f) => FUEL_LABEL[f] ?? f).join(", ")}</div>
          )}
        </div>
      )}
    </div>
  );
}
