import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { useAuth } from "../../shared/AuthContext";
import { useBrowserNotificationPermission } from "../../shared/useCriticalAlarmNotifications";

export default function ChangePassword() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 480 }}>
      <ChangePasswordCard />
      <NotificationSettingsCard />
    </div>
  );
}

function ChangePasswordCard() {
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
      setError("Yeni sifreler eslesmiyor.");
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
        setError("Sifre degistirilemedi.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2>Sifre Degistir</h2>
      <form onSubmit={handleSubmit}>
        <label>Mevcut sifre</label>
        <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        <label>Yeni sifre</label>
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
        <label>Yeni sifre (tekrar)</label>
        <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
        <p className="hint-text">En az 10 karakter; buyuk/kucuk harf, rakam ve ozel karakter icermelidir.</p>
        {error && <p className="error-text">{error}</p>}
        {success && <p className="hint-text" style={{ color: "#4ade80" }}>Sifreniz basariyla degistirildi.</p>}
        <button type="submit" className="primary" style={{ marginTop: "1rem" }} disabled={submitting}>
          {submitting ? "Kaydediliyor..." : "Sifreyi Guncelle"}
        </button>
      </form>
    </div>
  );
}

function NotificationSettingsCard() {
  const { user, refresh } = useAuth();
  const { permission, requestPermission, supported } = useBrowserNotificationPermission();
  const [email, setEmail] = useState(user?.email ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [notifyEmail, setNotifyEmail] = useState(user?.notifyEmail ?? true);
  const [notifySms, setNotifySms] = useState(user?.notifySms ?? false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function save() {
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await api.patch("/api/auth/notification-settings", {
        email: email.trim() || null,
        phone: phone.trim() || null,
        notifyEmail,
        notifySms,
      });
      setSuccess(true);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        const details = Array.isArray(err.details) ? ` (${err.details.join(" ")})` : "";
        setError(err.message + details);
      } else {
        setError("Ayarlar kaydedilemedi.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2>Bildirim Ayarlari</h2>
      <p className="hint-text">
        Istasyonunuzda kritik bir alarm olustugunda (orn. pompa arizasi) buradaki tercihlerinize gore bilgilendirilirsiniz.
      </p>
      <label>E-posta</label>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ornek@eposta.com" />
      <label>Telefon</label>
      <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="05xx xxx xx xx" />

      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.75rem" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={notifyEmail} onChange={(e) => setNotifyEmail(e.target.checked)} />
        Kritik alarmlarda e-posta gonder
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={notifySms} onChange={(e) => setNotifySms(e.target.checked)} />
        Kritik alarmlarda SMS gonder
      </label>

      {error && <p className="error-text">{error}</p>}
      {success && <p className="hint-text" style={{ color: "#4ade80" }}>Bildirim ayarlariniz kaydedildi.</p>}
      <button style={{ marginTop: "1rem" }} className="primary" disabled={submitting} onClick={save}>
        {submitting ? "Kaydediliyor..." : "Kaydet"}
      </button>

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "1.25rem 0" }} />

      <h4 style={{ margin: "0 0 0.5rem" }}>Tarayici Bildirimleri</h4>
      {supported ? (
        <>
          <p className="hint-text">
            Bu tarayicida panel acikken kritik alarmlar icin anlik bildirim gorebilirsiniz. Durum:{" "}
            <strong>{permission === "granted" ? "Izin verildi" : permission === "denied" ? "Reddedildi" : "Istenmedi"}</strong>
          </p>
          {permission !== "granted" && (
            <button onClick={requestPermission}>Bildirimlere Izin Ver</button>
          )}
        </>
      ) : (
        <p className="hint-text">Bu tarayici bildirimleri desteklemiyor.</p>
      )}
    </div>
  );
}
