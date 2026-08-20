import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { useAuth } from "../../shared/AuthContext";
import { useBrowserNotificationPermission } from "../../shared/useCriticalAlarmNotifications";

export default function ChangePassword() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 480 }}>
      <ChangePasswordCard />
      <TwoFactorCard />
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

function TwoFactorCard() {
  const { user, refresh } = useAuth();
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [enableCode, setEnableCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [showDisableForm, setShowDisableForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function startSetup() {
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const res = await api.post<{ secret: string; otpauthUri: string }>("/api/auth/2fa/setup");
      setSetupData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kurulum baslatilamadi.");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmEnable(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/api/auth/2fa/enable", { code: enableCode });
      setSetupData(null);
      setEnableCode("");
      setSuccess("Iki adimli dogrulama etkinlestirildi.");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kod dogrulanamadi.");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDisable(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/api/auth/2fa/disable", { password: disablePassword });
      setDisablePassword("");
      setShowDisableForm(false);
      setSuccess("Iki adimli dogrulama kapatildi.");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kapatilamadi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>Iki Adimli Dogrulama</h2>
        <div className="spacer" />
        <span className={`badge ${user?.totpEnabled ? "dispensing" : "offline"}`}>{user?.totpEnabled ? "Etkin" : "Kapali"}</span>
      </div>
      <p className="hint-text">
        Google Authenticator, Microsoft Authenticator gibi bir uygulamayla girislerinize ek bir dogrulama katmani ekler.
      </p>

      {error && <p className="error-text">{error}</p>}
      {success && <p className="hint-text" style={{ color: "#4ade80" }}>{success}</p>}

      {!user?.totpEnabled && !setupData && (
        <button className="primary" disabled={submitting} onClick={startSetup}>
          {submitting ? "Hazirlaniyor..." : "Etkinlestir"}
        </button>
      )}

      {!user?.totpEnabled && setupData && (
        <form onSubmit={confirmEnable} style={{ marginTop: "0.75rem" }}>
          <p className="hint-text">
            Authenticator uygulamanizda yeni bir hesap ekleyin ve asagidaki anahtari manuel olarak girin (veya cihazinizda
            uygulama yuklu ise <a href={setupData.otpauthUri}>bu baglantiya</a> dokunun):
          </p>
          <p>
            <code style={{ wordBreak: "break-all" }}>{setupData.secret}</code>
          </p>
          <label htmlFor="totp-enable-code">Uygulamada gorunen 6 haneli kod</label>
          <input
            id="totp-enable-code"
            inputMode="numeric"
            maxLength={6}
            value={enableCode}
            onChange={(e) => setEnableCode(e.target.value.replace(/\D/g, ""))}
            required
          />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? "Dogrulaniyor..." : "Kodu Dogrula ve Etkinlestir"}
            </button>
            <button type="button" className="ghost" onClick={() => setSetupData(null)}>
              Vazgec
            </button>
          </div>
        </form>
      )}

      {user?.totpEnabled && !showDisableForm && (
        <button className="danger" onClick={() => setShowDisableForm(true)}>
          Kapat
        </button>
      )}

      {user?.totpEnabled && showDisableForm && (
        <form onSubmit={confirmDisable} style={{ marginTop: "0.75rem" }}>
          <label htmlFor="totp-disable-password">Kapatmak icin sifrenizi girin</label>
          <input id="totp-disable-password" type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} required />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button type="submit" className="danger" disabled={submitting}>
              {submitting ? "Kapatiliyor..." : "Iki Adimli Dogrulamayi Kapat"}
            </button>
            <button type="button" className="ghost" onClick={() => setShowDisableForm(false)}>
              Vazgec
            </button>
          </div>
        </form>
      )}
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
