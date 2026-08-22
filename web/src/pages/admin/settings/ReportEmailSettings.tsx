import { useEffect, useState } from "react";
import { api, ApiError } from "../../../shared/api";
import { useEffectiveStationId } from "../../../shared/useEffectiveStation";

type ReportEmailFrequency = "none" | "weekly" | "monthly";

export default function ReportEmailSettings() {
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
    <div className="settings-page">
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
    </div>
  );
}
