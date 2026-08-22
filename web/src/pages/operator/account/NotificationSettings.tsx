import { useState } from "react";
import { api, ApiError } from "../../../shared/api";
import { useAuth } from "../../../shared/AuthContext";
import { useBrowserNotificationPermission } from "../../../shared/useCriticalAlarmNotifications";

export default function NotificationSettings() {
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
    <div className="account-page">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Bildirim Ayarları</h2>
        <p className="hint-text">
          İstasyonunuzda kritik bir alarm oluştuğunda (örn. pompa arızası) buradaki tercihlerinize göre bilgilendirilirsiniz.
        </p>
        <label>E-posta</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ornek@eposta.com" />
        <label>Telefon</label>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="05xx xxx xx xx" />

        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.75rem" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={notifyEmail} onChange={(e) => setNotifyEmail(e.target.checked)} />
          Kritik alarmlarda e-posta gönder
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={notifySms} onChange={(e) => setNotifySms(e.target.checked)} />
          Kritik alarmlarda SMS gönder
        </label>

        {error && <p className="error-text">{error}</p>}
        {success && <p className="hint-text" style={{ color: "#4ade80" }}>Bildirim ayarlarınız kaydedildi.</p>}
        <button style={{ marginTop: "1rem" }} className="primary" disabled={submitting} onClick={save}>
          {submitting ? "Kaydediliyor..." : "Kaydet"}
        </button>

        <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "1.25rem 0" }} />

        <h4 style={{ margin: "0 0 0.5rem" }}>Tarayıcı Bildirimleri</h4>
        {supported ? (
          <>
            <p className="hint-text">
              Bu tarayıcıda panel açıkken kritik alarmlar için anlık bildirim görebilirsiniz. Durum:{" "}
              <strong>{permission === "granted" ? "İzin verildi" : permission === "denied" ? "Reddedildi" : "İstenmedi"}</strong>
            </p>
            {permission !== "granted" && (
              <button onClick={requestPermission}>Bildirimlere İzin Ver</button>
            )}
          </>
        ) : (
          <p className="hint-text">Bu tarayıcı bildirimleri desteklemiyor.</p>
        )}
      </div>
    </div>
  );
}
