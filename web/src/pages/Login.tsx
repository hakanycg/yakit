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
      setError(err instanceof ApiError ? err.message : "Giris basarisiz oldu.");
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
      setError(err instanceof ApiError ? err.message : "Dogrulama basarisiz oldu.");
    } finally {
      setSubmitting(false);
    }
  }

  if (challengeToken) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h2>Dogrulama Kodu</h2>
          <p className="hint-text">Authenticator uygulamanizdaki 6 haneli kodu girin.</p>
          <form onSubmit={handleTotpSubmit}>
            <label htmlFor="code">Dogrulama kodu</label>
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
              {submitting ? "Dogrulaniyor..." : "Dogrula"}
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
              Geri don
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h2>Personel Girisi</h2>
        <p className="hint-text">Operator ve yonetici paneline erisim icin giris yapin.</p>
        <form onSubmit={handlePasswordSubmit}>
          <label htmlFor="username">Kullanici adi</label>
          <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
          <label htmlFor="password">Sifre</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="primary" style={{ width: "100%", marginTop: "1.5rem" }} disabled={submitting}>
            {submitting ? "Giris yapiliyor..." : "Giris Yap"}
          </button>
        </form>
        <p className="hint-text" style={{ marginTop: "1rem", textAlign: "center" }}>
          <Link to="/sifremi-unuttum">Sifremi unuttum</Link>
        </p>
      </div>
    </div>
  );
}
