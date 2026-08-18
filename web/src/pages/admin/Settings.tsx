import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { FUEL_LABEL } from "../../shared/format";
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
      </div>
    </div>
  );
}
