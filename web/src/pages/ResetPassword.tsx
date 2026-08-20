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
      setError("Sifreler eslesmiyor.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/auth/reset-password", { token, newPassword });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sifre sifirlanamadi.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h2>Sifre Sifirla</h2>
          <p className="error-text">Gecersiz baglanti. Lutfen e-postanizdaki/SMS'inizdeki baglantiyi kullanin.</p>
          <p className="hint-text" style={{ marginTop: "1rem" }}>
            <Link to="/sifremi-unuttum">Yeni bir sifirlama baglantisi iste</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h2>Sifre Sifirla</h2>
        {done ? (
          <>
            <p className="hint-text" style={{ color: "var(--accent-2)" }}>
              Sifreniz basariyla guncellendi. Yeni sifrenizle giris yapabilirsiniz.
            </p>
            <p className="hint-text" style={{ marginTop: "1.5rem" }}>
              <Link to="/giris">Giris ekranina git</Link>
            </p>
          </>
        ) : (
          <>
            <p className="hint-text">Hesabiniz icin yeni bir sifre belirleyin (en az 10 karakter, buyuk/kucuk harf, rakam ve ozel karakter icermeli).</p>
            <form onSubmit={handleSubmit}>
              <label htmlFor="newPassword">Yeni sifre</label>
              <input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoFocus
                required
              />
              <label htmlFor="confirmPassword">Yeni sifre (tekrar)</label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
              {error && <p className="error-text">{error}</p>}
              <button type="submit" className="primary" style={{ width: "100%", marginTop: "1.5rem" }} disabled={submitting}>
                {submitting ? "Kaydediliyor..." : "Sifreyi Guncelle"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
