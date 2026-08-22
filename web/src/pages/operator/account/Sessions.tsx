import { useEffect, useState } from "react";
import { api, ApiError } from "../../../shared/api";
import { formatDateTime } from "../../../shared/format";

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

export default function Sessions() {
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
    <div className="account-page">
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
    </div>
  );
}
