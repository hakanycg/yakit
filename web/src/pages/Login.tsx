import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../shared/AuthContext";
import { ApiError } from "../shared/api";

export default function Login() {
  const { user, login, loginWithTotp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) {
    const dest = user.role === "super_admin" ? "/admin/istasyonlar" : user.role === "admin" ? "/admin" : "/operator";
    return <Navigate to={dest} replace />;
  }

  function goToDestinationAfterLogin() {
    // Basarili girisin ardindan bilesen yeniden render olur; yukaridaki `if (user)`
    // bloğu role gore dogru sayfaya yonlendirir. `from` state'i varsa onu tercih eder.
    const state = location.state as { from?: string } | null;
    if (state?.from) navigate(state.from, { replace: true });
  }

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(username, password);
      if (result.requiresTotp && result.challengeToken) {
        setChallengeToken(result.challengeToken);
        return;
      }
      goToDestinationAfterLogin();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Giriş başarısız oldu.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTotpSubmit(e: FormEvent) {
    e.preventDefault();
    if (!challengeToken) return;
    setError(null);
    setSubmitting(true);
    try {
      await loginWithTotp(challengeToken, code);
      goToDestinationAfterLogin();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Doğrulama başarısız oldu.");
    } finally {
      setSubmitting(false);
    }
  }

  if (challengeToken) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h2>Doğrulama Kodu</h2>
          <p className="hint-text">Authenticator uygulamanızdaki 6 haneli kodu girin.</p>
          <form onSubmit={handleTotpSubmit}>
            <label htmlFor="code">Doğrulama kodu</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              autoFocus
              required
            />
            {error && <p className="error-text">{error}</p>}
            <button type="submit" className="primary" style={{ width: "100%", marginTop: "1.5rem" }} disabled={submitting}>
              {submitting ? "Doğrulanıyor..." : "Doğrula"}
            </button>
          </form>
          <p className="hint-text" style={{ marginTop: "1rem", textAlign: "center" }}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setChallengeToken(null);
                setCode("");
                setError(null);
              }}
            >
              Geri dön
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h2>Personel Girişi</h2>
        <p className="hint-text">Operatör ve yönetici paneline erişim için giriş yapın.</p>
        <form onSubmit={handlePasswordSubmit}>
          <label htmlFor="username">Kullanıcı adı</label>
          <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
          <label htmlFor="password">Şifre</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="primary" style={{ width: "100%", marginTop: "1.5rem" }} disabled={submitting}>
            {submitting ? "Giriş yapılıyor..." : "Giriş Yap"}
          </button>
        </form>
        <p className="hint-text" style={{ marginTop: "1rem", textAlign: "center" }}>
          <Link to="/sifremi-unuttum">Şifremi unuttum</Link>
        </p>
      </div>
    </div>
  );
}
