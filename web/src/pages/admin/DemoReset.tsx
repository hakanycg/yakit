import { useState } from "react";
import { api, ApiError } from "../../shared/api";

export default function DemoReset() {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleReset() {
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      await api.post("/api/settings/demo-reset", { confirm: true });
      setSuccess(true);
      setConfirmText("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Islem basarisiz.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Demo Verilerini Sifirla</h2>
      <div className="card" style={{ maxWidth: 520 }}>
        <p className="hint-text">
          Bu islem tum islem (transaction) ve alarm gecmisini siler, pompalari musait duruma dondurur ve yakit
          fiyatlarini varsayilan degerlere sifirlar. Kullanicilar ve denetim gunlugu (audit log) etkilenmez.
        </p>
        <label>Onaylamak icin <strong>SIFIRLA</strong> yazin</label>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        {error && <p className="error-text">{error}</p>}
        {success && <p className="hint-text" style={{ color: "#4ade80" }}>Veriler sifirlandi.</p>}
        <button className="danger" style={{ marginTop: "1rem" }} disabled={confirmText !== "SIFIRLA" || busy} onClick={handleReset}>
          {busy ? "Sifirlaniyor..." : "Verileri Sifirla"}
        </button>
      </div>
    </div>
  );
}
