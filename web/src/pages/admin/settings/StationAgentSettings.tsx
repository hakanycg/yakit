import { useEffect, useState } from "react";
import { api, ApiError } from "../../../shared/api";
import { useAuth } from "../../../shared/AuthContext";
import { useEffectiveStationId } from "../../../shared/useEffectiveStation";
import { formatDateTime } from "../../../shared/format";

interface SyncStatus {
  lastHeartbeatAt: string | null;
  lastSyncedAt: string | null;
  agentConfigured: boolean;
}

/**
 * Token'i yeniden olusturmak eski token'i aninda gecersiz kilar (istasyondaki
 * ajan tekrar yapilandirilana kadar senkronizasyon duracaktir) - bu yuzden
 * hesabinda 2FA acik olan bir kullanici icin acilir bir pencerede guncel TOTP
 * kodu istenir (bkz. server/src/routes/sync.ts). 2FA'si olmayan kullanicilar
 * icin ayni pencere sadece bir onay adimi olarak gorunur.
 */
function RotateTokenDialog({ requiresTotp, onClose, onRotated }: { requiresTotp: boolean; onClose: () => void; onRotated: (token: string) => void }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{ syncToken: string }>("/api/sync/token/rotate", requiresTotp ? { code: code.trim() } : undefined);
      onRotated(res.syncToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Token yeniden olusturulamadi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
      <div className="card" style={{ width: "min(420px, 92vw)" }}>
        <h3>Senkron Token'ı Yeniden Oluştur</h3>
        <p className="error-text">
          Bu işlem mevcut token'ı anında geçersiz kılar. İstasyondaki ajan, yeni token yapılandırılana kadar
          senkronizasyon yapamaz.
        </p>
        {requiresTotp ? (
          <>
            <label htmlFor="rotate-totp-code">Doğrulayıcı uygulamadaki 6 haneli kod</label>
            <input
              id="rotate-totp-code"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </>
        ) : (
          <p className="hint-text">
            Hesabınızda iki aşamalı doğrulama açık değil, bu yüzden yalnızca onayınız isteniyor. Daha güvenli olması
            için "Hesabım &gt; İki Adımlı Doğrulama" üzerinden 2FA'yı etkinleştirmenizi öneririz.
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="toolbar" style={{ marginTop: "1.25rem" }}>
          <button onClick={onClose} disabled={submitting}>Vazgeç</button>
          <div className="spacer" />
          <button className="danger" onClick={submit} disabled={submitting || (requiresTotp && code.length !== 6)}>
            {submitting ? "Doğrulanıyor..." : "Evet, Yeniden Oluştur"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StationAgentSettings() {
  const { user } = useAuth();
  const stationId = useEffectiveStationId();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);

  function loadStatus() {
    if (stationId === null) return;
    api.get<SyncStatus>("/api/sync/status").then(setStatus).catch(() => setStatus(null));
  }
  useEffect(() => {
    setToken(null);
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId]);

  async function revealToken() {
    setLoadingToken(true);
    setError(null);
    try {
      const res = await api.get<{ syncToken: string }>("/api/sync/token");
      setToken(res.syncToken);
      loadStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Token alınamadı.");
    } finally {
      setLoadingToken(false);
    }
  }

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Panoya kopyalanamadı, elle seçip kopyalayın.");
    }
  }

  if (!status) return null;

  return (
    <div className="settings-page">
      <div className="card settings-card">
        <div className="card-head">
          <h3>İstasyon Ajanı Kurulumu</h3>
          <span className={`badge ${status.agentConfigured ? "completed" : "info"}`}>
            {status.agentConfigured ? "Bağlı" : "Ajan kurulmadı"}
          </span>
        </div>
        <p className="hint-text card-desc">
          İstasyon ajanı, kiosk bilgisayarında arka planda çalışan ve internet kesintisinde işlemleri yerelde
          kuyruğa alıp bağlantı geri gelince senkronize eden ayrı bir program. Aşağıdaki token'ı ajanın{" "}
          <code>.env</code> dosyasındaki <code>STATION_SYNC_TOKEN</code> alanına girin.
        </p>

        <div className="toolbar" style={{ margin: "0.5rem 0" }}>
          <span className="hint-text">Son heartbeat:</span>
          <strong>{formatDateTime(status.lastHeartbeatAt)}</strong>
          <div className="spacer" />
          <span className="hint-text">Son senkron:</span>
          <strong>{formatDateTime(status.lastSyncedAt)}</strong>
        </div>

        {token ? (
          <div className="toolbar" style={{ flexWrap: "nowrap" }}>
            <code style={{ flex: 1, minWidth: 0, overflowX: "auto", whiteSpace: "nowrap", padding: "0.5rem 0.75rem", background: "var(--panel-2)", borderRadius: "8px" }}>
              {token}
            </code>
            <button onClick={copyToken}>{copied ? "Kopyalandı" : "Kopyala"}</button>
          </div>
        ) : (
          <button onClick={revealToken} disabled={loadingToken}>
            {loadingToken ? "Yükleniyor..." : status.agentConfigured ? "Token'ı Göster" : "Token Oluştur ve Göster"}
          </button>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="card-divider">
          <button onClick={() => setRotateOpen(true)}>Token'ı Yeniden Oluştur</button>
          <p className="hint-text" style={{ marginTop: "0.4rem" }}>
            Token ele geçirilmiş olabileceğini düşünüyorsanız yeniden oluşturun; eski token anında geçersiz olur.
          </p>
        </div>

        {rotateOpen && (
          <RotateTokenDialog
            requiresTotp={!!user?.totpEnabled}
            onClose={() => setRotateOpen(false)}
            onRotated={(newToken) => {
              setToken(newToken);
              setRotateOpen(false);
              loadStatus();
            }}
          />
        )}
      </div>
    </div>
  );
}
