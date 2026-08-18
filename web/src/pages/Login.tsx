import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../shared/AuthContext";
import { ApiError } from "../shared/api";

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) {
    const dest = user.role === "admin" ? "/admin" : "/operator";
    return <Navigate to={dest} replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      const state = location.state as { from?: string } | null;
      navigate(state?.from ?? "/operator", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Giris basarisiz oldu.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h2>Personel Girisi</h2>
        <p className="hint-text">Operator ve yonetici paneline erisim icin giris yapin.</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="username">Kullanici adi</label>
          <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
          <label htmlFor="password">Sifre</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="primary" style={{ width: "100%", marginTop: "1.5rem" }} disabled={submitting}>
            {submitting ? "Giris yapiliyor..." : "Giris Yap"}
          </button>
        </form>
      </div>
    </div>
  );
}
