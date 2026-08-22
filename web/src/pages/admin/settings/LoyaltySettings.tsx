import { useEffect, useState } from "react";
import { api, ApiError } from "../../../shared/api";
import { useEffectiveStationId } from "../../../shared/useEffectiveStation";
import StatusToggle from "./StatusToggle";

interface LoyaltyConfig {
  enabled: boolean;
  pointsPerLiter: number;
  pointValueTry: number;
}

export default function LoyaltySettings() {
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
    <div className="settings-page">
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
    </div>
  );
}
