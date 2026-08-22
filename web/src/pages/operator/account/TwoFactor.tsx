import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../../shared/api";
import { useAuth } from "../../../shared/AuthContext";

export default function TwoFactor() {
  const { user, refresh } = useAuth();
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null);
  const [enableCode, setEnableCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [showDisableForm, setShowDisableForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function startSetup() {
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const res = await api.post<{ secret: string; otpauthUri: string; qrDataUrl: string }>("/api/auth/2fa/setup");
      setSetupData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kurulum başlatılamadı.");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmEnable(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/api/auth/2fa/enable", { code: enableCode });
      setSetupData(null);
      setEnableCode("");
      setSuccess("İki adımlı doğrulama etkinleştirildi.");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kod doğrulanamadı.");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDisable(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/api/auth/2fa/disable", { password: disablePassword });
      setDisablePassword("");
      setShowDisableForm(false);
      setSuccess("İki adımlı doğrulama kapatıldı.");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kapatılamadı.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="account-page">
      <div className="card">
        <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
          <h2 style={{ margin: 0 }}>İki Adımlı Doğrulama</h2>
          <div className="spacer" />
          <span className={`badge ${user?.totpEnabled ? "dispensing" : "offline"}`}>{user?.totpEnabled ? "Etkin" : "Kapalı"}</span>
        </div>
        <p className="hint-text">
          Google Authenticator, Microsoft Authenticator gibi bir uygulamayla girişlerinize ek bir doğrulama katmanı ekler.
        </p>

        {error && <p className="error-text">{error}</p>}
        {success && <p className="hint-text" style={{ color: "#4ade80" }}>{success}</p>}

        {!user?.totpEnabled && !setupData && (
          <button className="primary" disabled={submitting} onClick={startSetup}>
            {submitting ? "Hazırlanıyor..." : "Etkinleştir"}
          </button>
        )}

        {!user?.totpEnabled && setupData && (
          <form onSubmit={confirmEnable} style={{ marginTop: "0.75rem" }}>
            <p className="hint-text">
              Authenticator uygulamanızda yeni bir hesap eklemek için aşağıdaki QR kodu tarayın:
            </p>
            <p style={{ textAlign: "center" }}>
              <img src={setupData.qrDataUrl} alt="Authenticator kurulum QR kodu" width={200} height={200} style={{ background: "#fff", padding: "0.5rem", borderRadius: "0.5rem" }} />
            </p>
            <details>
              <summary className="hint-text" style={{ cursor: "pointer" }}>Kamera ile tarayamıyorsanız: anahtarı elle girin</summary>
              <p className="hint-text" style={{ marginTop: "0.5rem" }}>
                Authenticator uygulamanızda hesabı "zaman tabanlı (TOTP)" seçerek elle ekleyin:
              </p>
              <p>
                <code style={{ wordBreak: "break-all" }}>{setupData.secret}</code>
              </p>
            </details>
            <label htmlFor="totp-enable-code">Uygulamada görünen 6 haneli kod</label>
            <input
              id="totp-enable-code"
              inputMode="numeric"
              maxLength={6}
              value={enableCode}
              onChange={(e) => setEnableCode(e.target.value.replace(/\D/g, ""))}
              required
            />
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
              <button type="submit" className="primary" disabled={submitting}>
                {submitting ? "Doğrulanıyor..." : "Kodu Doğrula ve Etkinleştir"}
              </button>
              <button type="button" className="ghost" onClick={() => setSetupData(null)}>
                Vazgeç
              </button>
            </div>
          </form>
        )}

        {user?.totpEnabled && !showDisableForm && (
          <button className="danger" onClick={() => setShowDisableForm(true)}>
            Kapat
          </button>
        )}

        {user?.totpEnabled && showDisableForm && (
          <form onSubmit={confirmDisable} style={{ marginTop: "0.75rem" }}>
            <label htmlFor="totp-disable-password">Kapatmak için şifrenizi girin</label>
            <input id="totp-disable-password" type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} required />
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
              <button type="submit" className="danger" disabled={submitting}>
                {submitting ? "Kapatılıyor..." : "İki Adımlı Doğrulamayı Kapat"}
              </button>
              <button type="button" className="ghost" onClick={() => setShowDisableForm(false)}>
                Vazgeç
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
