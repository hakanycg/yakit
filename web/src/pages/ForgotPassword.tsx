import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../shared/api";

export default function ForgotPassword() {
  const [identifier, setIdentifier] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/api/auth/forgot-password", { identifier });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İstek gönderilemedi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h2>Şifremi Unuttum</h2>
        {done ? (
          <>
            <p className="hint-text">
              Bu bilgilerle eşleşen bir hesap varsa, kayıtlı e-posta/telefon numarasına şifre sıfırlama
              talimatları gönderildi. Gelen kutunuzu (ve spam klasörünü) kontrol edin.
            </p>
            <p className="hint-text" style={{ marginTop: "1.5rem" }}>
              <Link to="/giris">Giriş ekranına dön</Link>
            </p>
          </>
        ) : (
          <>
            <p className="hint-text">
              Kullanıcı adınızı veya hesabınıza kayıtlı e-posta adresini girin; eğer hesabınızda bir e-posta
              veya telefon numarası kayıtlıysa size şifre sıfırlama bağlantısı gönderilir.
            </p>
            <form onSubmit={handleSubmit}>
              <label htmlFor="identifier">Kullanıcı adı veya e-posta</label>
              <input id="identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus required />
              {error && <p className="error-text">{error}</p>}
              <button type="submit" className="primary" style={{ width: "100%", marginTop: "1.5rem" }} disabled={submitting}>
                {submitting ? "Gönderiliyor..." : "Sıfırlama Bağlantısı Gönder"}
              </button>
            </form>
            <p className="hint-text" style={{ marginTop: "1rem" }}>
              <Link to="/giris">Giriş ekranına dön</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
