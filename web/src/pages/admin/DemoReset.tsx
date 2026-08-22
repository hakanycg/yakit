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
      setError(err instanceof ApiError ? err.message : "İşlem başarısız.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Demo Verilerini Sıfırla</h2>
      <div className="card" style={{ maxWidth: 520 }}>
        <p className="hint-text">
          Bu işlem tüm işlem (transaction) ve alarm geçmişini siler, pompaları müsait duruma döndürür ve yakıt
          fiyatlarını varsayılan değerlere sıfırlar. Kullanıcılar ve denetim günlüğü (audit log) etkilenmez.
        </p>
        <label>Onaylamak için <strong>SIFIRLA</strong> yazın</label>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        {error && <p className="error-text">{error}</p>}
        {success && <p className="hint-text" style={{ color: "#4ade80" }}>Veriler sıfırlandı.</p>}
        <button className="danger" style={{ marginTop: "1rem" }} disabled={confirmText !== "SIFIRLA" || busy} onClick={handleReset}>
          {busy ? "Sıfırlanıyor..." : "Verileri Sıfırla"}
        </button>
      </div>
    </div>
  );
}
