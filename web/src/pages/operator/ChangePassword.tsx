import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { useAuth } from "../../shared/AuthContext";
import { useBrowserNotificationPermission } from "../../shared/useCriticalAlarmNotifications";
import { formatDateTime } from "../../shared/format";

export default function ChangePassword() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 640 }}>
      <ChangePasswordCard />
      <TwoFactorCard />
      <SessionsCard />
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
  );
}

function TwoFactorCard() {
  const { user, refresh } = useAuth();
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null);
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
      const res = await api.post<{ secret: string; otpauthUri: string; qrDataUrl: string }>("/api/auth/2fa/setup");
      setSetupData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kurulum başlatılamadı.");
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
      setSuccess("İki adımlı doğrulama etkinleştirildi.");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kod doğrulanamadı.");
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
      setSuccess("İki adımlı doğrulama kapatıldı.");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kapatılamadı.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>İki Adımlı Doğrulama</h2>
        <div className="spacer" />
        <span className={`badge ${user?.totpEnabled ? "dispensing" : "offline"}`}>{user?.totpEnabled ? "Etkin" : "Kapalı"}</span>
      </div>
      <p className="hint-text">
        Google Authenticator, Microsoft Authenticator gibi bir uygulamayla girişlerinize ek bir doğrulama katmanı ekler.
      </p>

      {error && <p className="error-text">{error}</p>}
      {success && <p className="hint-text" style={{ color: "#4ade80" }}>{success}</p>}

      {!user?.totpEnabled && !setupData && (
        <button className="primary" disabled={submitting} onClick={startSetup}>
          {submitting ? "Hazırlanıyor..." : "Etkinleştir"}
        </button>
      )}

      {!user?.totpEnabled && setupData && (
        <form onSubmit={confirmEnable} style={{ marginTop: "0.75rem" }}>
          <p className="hint-text">
            Authenticator uygulamanızda yeni bir hesap eklemek için aşağıdaki QR kodu tarayın:
          </p>
          <p style={{ textAlign: "center" }}>
            <img src={setupData.qrDataUrl} alt="Authenticator kurulum QR kodu" width={200} height={200} style={{ background: "#fff", padding: "0.5rem", borderRadius: "0.5rem" }} />
          </p>
          <details>
            <summary className="hint-text" style={{ cursor: "pointer" }}>Kamera ile tarayamıyorsanız: anahtarı elle girin</summary>
            <p className="hint-text" style={{ marginTop: "0.5rem" }}>
              Authenticator uygulamanızda hesabı "zaman tabanlı (TOTP)" seçerek elle ekleyin:
            </p>
            <p>
              <code style={{ wordBreak: "break-all" }}>{setupData.secret}</code>
            </p>
          </details>
          <label htmlFor="totp-enable-code">Uygulamada görünen 6 haneli kod</label>
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
              {submitting ? "Doğrulanıyor..." : "Kodu Doğrula ve Etkinleştir"}
            </button>
            <button type="button" className="ghost" onClick={() => setSetupData(null)}>
              Vazgeç
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
          <label htmlFor="totp-disable-password">Kapatmak için şifrenizi girin</label>
          <input id="totp-disable-password" type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} required />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button type="submit" className="danger" disabled={submitting}>
              {submitting ? "Kapatılıyor..." : "İki Adımlı Doğrulamayı Kapat"}
            </button>
            <button type="button" className="ghost" onClick={() => setShowDisableForm(false)}>
              Vazgeç
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

interface SessionInfo {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

/** User-Agent metnini tam haliyle gostermek yerine, tanidik bir tarayici/isletim sistemi ozeti cikarir. */
function describeUserAgent(ua: string | null): string {
  if (!ua) return "Bilinmiyor";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Tarayıcı";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

function SessionsCard() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  function load() {
    api.get<{ sessions: SessionInfo[] }>("/api/auth/sessions").then((res) => setSessions(res.sessions));
  }
  useEffect(load, []);

  async function revoke(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.delete(`/api/auth/sessions/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Oturum kapatılamadı.");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeOthers() {
    setRevokingOthers(true);
    setError(null);
    try {
      await api.post("/api/auth/sessions/revoke-others");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Oturumlar kapatılamadı.");
    } finally {
      setRevokingOthers(false);
    }
  }

  const otherCount = sessions ? sessions.filter((s) => !s.isCurrent).length : 0;

  return (
    <div className="card">
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>Aktif Oturumlar</h2>
        <div className="spacer" />
        {otherCount > 0 && (
          <button className="danger" disabled={revokingOthers} onClick={revokeOthers}>
            {revokingOthers ? "Kapatılıyor..." : `Diğer ${otherCount} Oturumu Kapat`}
          </button>
        )}
      </div>
      <p className="hint-text">Hesabınızla giriş yapılmış tüm cihazlar. Tanımadığınız bir oturum görürseniz kapatın.</p>
      {error && <p className="error-text">{error}</p>}

      <table>
        <thead>
          <tr>
            <th>Cihaz</th>
            <th>IP</th>
            <th>Son Görüldü</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sessions?.map((s) => (
            <tr key={s.id}>
              <td>
                {describeUserAgent(s.userAgent)}
                {s.isCurrent && <span className="badge dispensing" style={{ marginLeft: "0.4rem" }}>Bu cihaz</span>}
              </td>
              <td>{s.ipAddress ?? "-"}</td>
              <td>{formatDateTime(s.lastSeenAt)}</td>
              <td>
                {!s.isCurrent && (
                  <button disabled={busyId === s.id} onClick={() => revoke(s.id)}>
                    {busyId === s.id ? "..." : "Kapat"}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {sessions?.length === 0 && <tr><td colSpan={4} className="hint-text">Kayıt yok.</td></tr>}
          {sessions === null && <tr><td colSpan={4} className="hint-text">Yükleniyor...</td></tr>}
        </tbody>
      </table>
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
      <h2>Bildirim Ayarları</h2>
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
  );
}
