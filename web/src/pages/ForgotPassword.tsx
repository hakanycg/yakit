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
      setError(err instanceof ApiError ? err.message : "Istek gonderilemedi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h2>Sifremi Unuttum</h2>
        {done ? (
          <>
            <p className="hint-text">
              Bu bilgilerle eslesen bir hesap varsa, kayitli e-posta/telefon numarasina sifre sifirlama
              talimatlari gonderildi. Gelen kutunuzu (ve spam klasorunu) kontrol edin.
            </p>
            <p className="hint-text" style={{ marginTop: "1.5rem" }}>
              <Link to="/giris">Giris ekranina don</Link>
            </p>
          </>
        ) : (
          <>
            <p className="hint-text">
              Kullanici adinizi veya hesabiniza kayitli e-posta adresini girin; eger hesabinizda bir e-posta
              veya telefon numarasi kayitliysa size sifre sifirlama baglantisi gonderilir.
            </p>
            <form onSubmit={handleSubmit}>
              <label htmlFor="identifier">Kullanici adi veya e-posta</label>
              <input id="identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus required />
              {error && <p className="error-text">{error}</p>}
              <button type="submit" className="primary" style={{ width: "100%", marginTop: "1.5rem" }} disabled={submitting}>
                {submitting ? "Gonderiliyor..." : "Sifirlama Baglantisi Gonder"}
              </button>
            </form>
            <p className="hint-text" style={{ marginTop: "1rem" }}>
              <Link to="/giris">Giris ekranina don</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
