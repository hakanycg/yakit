import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../shared/api";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("Şifreler eşleşmiyor.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/auth/reset-password", { token, newPassword });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Şifre sıfırlanamadı.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h2>Şifre Sıfırla</h2>
          <p className="error-text">Geçersiz bağlantı. Lütfen e-postanızdaki/SMS'inizdeki bağlantıyı kullanın.</p>
          <p className="hint-text" style={{ marginTop: "1rem" }}>
            <Link to="/sifremi-unuttum">Yeni bir sıfırlama bağlantısı iste</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h2>Şifre Sıfırla</h2>
        {done ? (
          <>
            <p className="hint-text" style={{ color: "var(--accent-2)" }}>
              Şifreniz başarıyla güncellendi. Yeni şifrenizle giriş yapabilirsiniz.
            </p>
            <p className="hint-text" style={{ marginTop: "1.5rem" }}>
              <Link to="/giris">Giriş ekranına git</Link>
            </p>
          </>
        ) : (
          <>
            <p className="hint-text">Hesabınız için yeni bir şifre belirleyin (en az 10 karakter, büyük/küçük harf, rakam ve özel karakter içermeli).</p>
            <form onSubmit={handleSubmit}>
              <label htmlFor="newPassword">Yeni şifre</label>
              <input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoFocus
                required
              />
              <label htmlFor="confirmPassword">Yeni şifre (tekrar)</label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
              {error && <p className="error-text">{error}</p>}
              <button type="submit" className="primary" style={{ width: "100%", marginTop: "1.5rem" }} disabled={submitting}>
                {submitting ? "Kaydediliyor..." : "Şifreyi Güncelle"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
