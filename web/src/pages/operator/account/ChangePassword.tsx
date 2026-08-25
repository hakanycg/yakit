import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../../shared/api";
import { useAuth } from "../../../shared/AuthContext";

export default function ChangePassword() {
  const { refresh } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword !== confirmPassword) {
      setError("Yeni şifreler eşleşmiyor.");
      return;
    }

    setSubmitting(true);
    try {
      await api.post("/api/auth/change-password", { currentPassword, newPassword });
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        const details = Array.isArray(err.details) ? ` (${err.details.join(" ")})` : "";
        setError(err.message + details);
      } else {
        setError("Şifre değiştirilemedi.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="account-page">
      <div className="card">
        <h2>Şifre Değiştir</h2>
        <form onSubmit={handleSubmit}>
          <label>Mevcut şifre</label>
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
          <label>Yeni şifre</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
          <label>Yeni şifre (tekrar)</label>
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
          <p className="hint-text">En az 10 karakter; büyük/küçük harf, rakam ve özel karakter içermelidir.</p>
          {error && <p className="error-text">{error}</p>}
          {success && <p className="hint-text" style={{ color: "#4ade80" }}>Şifreniz başarıyla değiştirildi.</p>}
          <button type="submit" className="primary" style={{ marginTop: "1rem" }} disabled={submitting}>
            {submitting ? "Kaydediliyor..." : "Şifreyi Güncelle"}
          </button>
        </form>
      </div>
    </div>
  );
}
