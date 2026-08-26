import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useEscapeKey } from "../../shared/useEscapeKey";
import { useTopicSubscription } from "../../shared/useWebSocket";
import { formatDateTime } from "../../shared/format";
import type { SupportRequest } from "../../shared/types";

/**
 * Kiosk'tan gelen musteri destek talepleri.
 *
 * Personelsiz istasyonda takilan bir musterinin tek kanali bu; talepler kritik alarma
 * cevrildigi icin e-posta/SMS de gider, bu sayfa ise "kim bekliyor, ne oldu, kim
 * ilgilendi" sorusunun kayitli hali.
 *
 * Kapatilmis talepler de gorulebildigi icin liste yuzlerce satira ulasabilir; her
 * talebin tum detayini alt alta acik kart olarak dizmek sayfayi taranamaz hale
 * getiriyordu. Istasyonlar sayfasindaki desen izleniyor: liste tek satir, detay ve
 * kapatma formu satira tiklaninca acilan pencerede.
 */

const CATEGORY_HINT: Record<string, string> = {
  payment: "Kart okumadı / para çekildi",
  dispenser: "Yakıt akmıyor",
  receipt: "Fiş / makbuz",
  other: "Diğer",
};

type Filter = "open" | "all";

export default function SupportRequests() {
  const stationId = useEffectiveStationId();
  const [requests, setRequests] = useState<SupportRequest[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [filter, setFilter] = useState<Filter>("open");
  const [detailId, setDetailId] = useState<number | null>(null);

  function load() {
    if (stationId === null) return;
    const query = filter === "all" ? "" : "?status=open";
    api.get<{ requests: SupportRequest[]; openCount: number }>(`/api/support${query}`).then((res) => {
      setRequests(res.requests);
      setOpenCount(res.openCount);
    });
  }

  useEffect(load, [stationId, filter]);
  // Musteri istasyonda bekliyor olabilir: yeni talep aninda ekrana dussun.
  useTopicSubscription(stationId !== null ? `support:${stationId}` : null, load);

  const detail = detailId === null ? null : requests.find((r) => r.id === detailId) ?? null;

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
        {/* Iki durumlu bir filtre, isaretlenecek bir tercih degil bir gorunum secimidir:
            onay kutusu yerine hangi gorunumde oldugunuzu gosteren segment dugmesi. */}
        <div className="segmented" role="group" aria-label="Talep filtresi">
          <button type="button" className={filter === "open" ? "active" : ""} aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
            Açık
          </button>
          <button type="button" className={filter === "all" ? "active" : ""} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            Tümü
          </button>
        </div>
      </div>

      <div className="station-list">
        {requests.map((r) => (
          <button type="button" className="station-row" key={r.id} onClick={() => setDetailId(r.id)}>
            <span className="station-row-main">
              <span className="station-row-name">
                #{r.id} · {r.categoryLabel}
              </span>
              <span className="station-row-sub">
                <span className="station-row-address">{CATEGORY_HINT[r.category] ?? r.categoryLabel}</span>
                {r.pumpNumber !== null && <span className="station-row-address">Pompa {r.pumpNumber}</span>}
              </span>
            </span>
            <span className="station-row-badges">
              <span className={`badge ${r.status === "open" ? "critical" : "resolved"}`}>
                {r.status === "open" ? "Açık" : "Kapatıldı"}
              </span>
            </span>
            <span className="station-row-counts hint-text">{formatDateTime(r.createdAt)}</span>
            <span className="station-row-chevron">›</span>
          </button>
        ))}
        {requests.length === 0 && (
          <p className="hint-text">{filter === "all" ? "Hiç destek talebi yok." : "Açık destek talebi yok."}</p>
        )}
      </div>

      {detail && (
        <RequestDialog
          request={detail}
          onClose={() => setDetailId(null)}
          onResolved={() => {
            setDetailId(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function RequestDialog({
  request: r,
  onClose,
  onResolved,
}: {
  request: SupportRequest;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscapeKey(onClose);

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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
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
          <button className="ghost btn-sm" onClick={onClose} aria-label="Kapat">✕</button>
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
          <form onSubmit={resolve}>
            <label htmlFor={`support-note-${r.id}`}>Çözüm notu (opsiyonel)</label>
            <input
              id={`support-note-${r.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="ör. Pompa resetlendi, müşteri dolumu tamamladı"
              maxLength={500}
              autoFocus
            />
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={onClose}>Vazgeç</button>
              <div className="spacer" />
              <button type="submit" className="primary" disabled={saving}>
                {saving ? "Kapatılıyor..." : "Talebi Kapat"}
              </button>
            </div>
          </form>
        )}

        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
