import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useTopicSubscription } from "../../shared/useWebSocket";
import { formatDateTime } from "../../shared/format";
import type { SupportRequest } from "../../shared/types";

/**
 * Kiosk'tan gelen musteri destek talepleri.
 *
 * Personelsiz istasyonda takilan bir musterinin tek kanali bu; talepler kritik alarma
 * cevrildigi icin e-posta/SMS de gider, bu sayfa ise "kim bekliyor, ne oldu, kim
 * ilgilendi" sorusunun kayitli hali.
 */

const CATEGORY_HINT: Record<string, string> = {
  payment: "Kart okumadı / para çekildi",
  dispenser: "Yakıt akmıyor",
  receipt: "Fiş / makbuz",
  other: "Diğer",
};

export default function SupportRequests() {
  const stationId = useEffectiveStationId();
  const [requests, setRequests] = useState<SupportRequest[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [showResolved, setShowResolved] = useState(false);

  function load() {
    if (stationId === null) return;
    const query = showResolved ? "" : "?status=open";
    api
      .get<{ requests: SupportRequest[]; openCount: number }>(`/api/support${query}`)
      .then((res) => {
        setRequests(res.requests);
        setOpenCount(res.openCount);
      });
  }

  useEffect(load, [stationId, showResolved]);
  // Musteri istasyonda bekliyor olabilir: yeni talep aninda ekrana dussun.
  useTopicSubscription(stationId !== null ? `support:${stationId}` : null, load);

  return (
    <div>
      <h2>Destek Talepleri</h2>
      <p className="hint-text">
        Kiosk ekranındaki "Yardım / Destek" butonundan gelen müşteri talepleri. Her talep aynı zamanda kritik alarm
        oluşturur ve nöbetçi personele e-posta/SMS gider.
      </p>

      <div className="toolbar">
        <span className={`badge ${openCount > 0 ? "critical" : "resolved"}`}>{openCount} açık talep</span>
        <div className="spacer" />
        <label style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Kapatılmışları da göster
        </label>
      </div>

      {requests.length === 0 && (
        <div className="card">
          <p className="hint-text" style={{ margin: 0 }}>
            {showResolved ? "Hiç destek talebi yok." : "Açık destek talebi yok."}
          </p>
        </div>
      )}

      {requests.map((r) => (
        <RequestCard key={r.id} request={r} onResolved={load} />
      ))}
    </div>
  );
}

function RequestCard({ request: r, onResolved }: { request: SupportRequest; onResolved: () => void }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/support/${r.id}/resolve`, { note: note.trim() || undefined });
      onResolved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Talep kapatılamadı.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="station-card-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="station-name">
            #{r.id} · {r.categoryLabel}
          </div>
          <div className="station-card-badges">
            <span className={`badge ${r.status === "open" ? "critical" : "resolved"}`}>
              {r.status === "open" ? "Açık" : "Kapatıldı"}
            </span>
            <span className="hint-text">{formatDateTime(r.createdAt)}</span>
          </div>
        </div>
      </div>

      <dl className="detail-list">
        <dt>Sorun</dt>
        <dd>{CATEGORY_HINT[r.category] ?? r.categoryLabel}</dd>
        {r.pumpNumber !== null && (
          <>
            <dt>Pompa</dt>
            <dd>Pompa {r.pumpNumber}</dd>
          </>
        )}
        {r.transactionId !== null && (
          <>
            <dt>İşlem</dt>
            <dd>#{r.transactionId}</dd>
          </>
        )}
        {r.message && (
          <>
            <dt>Müşteri notu</dt>
            <dd>{r.message}</dd>
          </>
        )}
        {r.contactPhone && (
          <>
            <dt>Geri arama</dt>
            <dd>
              <a href={`tel:${r.contactPhone}`}>{r.contactPhone}</a>
            </dd>
          </>
        )}
        {r.status === "resolved" && (
          <>
            <dt>Kapatan</dt>
            <dd>
              {r.resolvedBy ?? "—"} · {formatDateTime(r.resolvedAt)}
            </dd>
            {r.resolutionNote && (
              <>
                <dt>Çözüm notu</dt>
                <dd>{r.resolutionNote}</dd>
              </>
            )}
          </>
        )}
      </dl>

      {r.status === "open" && (
        <form onSubmit={resolve} className="toolbar">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Çözüm notu (opsiyonel)"
            maxLength={500}
            style={{ flex: "1 1 240px", minWidth: 0 }}
          />
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Kapatılıyor..." : "Talebi Kapat"}
          </button>
        </form>
      )}

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
