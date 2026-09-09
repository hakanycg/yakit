import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { appendStationParam } from "../../shared/stationScope";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useAuth } from "../../shared/AuthContext";
import { formatDateTime } from "../../shared/format";

/**
 * Interkom kayitlarinin (bkz. callRecordingService.ts) yonetim ekrani - yalnizca
 * yonetim rolleri gorebilir (bkz. AppLayout.tsx isStationAdmin gate + sunucu
 * tarafinda requireRole, routes/intercomRecordings.ts). Dinleme HER SEFERINDE
 * denetim izine yazilir (bkz. audit_log_viewed ile ayni ilke) - bu ekran bir
 * ses dosyasi indirme aracidan cok, "kim ne zaman dinledi" izi biriken bir
 * guvenlik kontrol noktasidir.
 */

interface RecordingRow {
  id: number;
  callId: string;
  kioskId: number | null;
  pumpId: number | null;
  startedAt: string;
  endedAt: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

const PAGE_SIZE = 50;

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function IntercomRecordings() {
  const stationId = useEffectiveStationId();
  const { user } = useAuth();
  const canEditRetention = user?.role === "super_admin" || user?.role === "tenant_admin";

  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [retentionInput, setRetentionInput] = useState("");
  const [savingRetention, setSavingRetention] = useState(false);
  const [playingId, setPlayingId] = useState<number | null>(null);

  useEffect(() => {
    if (stationId === null) return;
    api.get<{ enabled: boolean }>("/api/intercom-recordings/config").then((res) => setEnabled(res.enabled));
    api.get<{ days: number }>("/api/intercom-recordings/retention").then((res) => {
      setRetentionDays(res.days);
      setRetentionInput(String(res.days));
    });
  }, [stationId]);

  function loadPage(newOffset: number) {
    api.get<{ recordings: RecordingRow[]; total: number }>(`/api/intercom-recordings?limit=${PAGE_SIZE}&offset=${newOffset}`).then((res) => {
      setRecordings(res.recordings);
      setTotal(res.total);
      setOffset(newOffset);
    });
  }

  useEffect(() => {
    if (stationId === null) return;
    loadPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId]);

  async function saveRetention() {
    const days = Number(retentionInput);
    if (!Number.isFinite(days)) return;
    setSavingRetention(true);
    try {
      const res = await api.patch<{ days: number }>("/api/intercom-recordings/retention", { days });
      setRetentionDays(res.days);
    } finally {
      setSavingRetention(false);
    }
  }

  return (
    <div>
      <h2>İnterkom Kayıtları</h2>
      <p className="hint-text">
        Müşteri&ndash;görevli interkom görüşmelerinin güvenlik amaçlı ses kayıtları (bkz. TS 12820 madde 4.9.3.5).
        Kayıt yalnızca görevlinin (aramayı yanıtlayan taraf) tarayıcısında alınır ve sifreli olarak saklanır.
        Her dinleme denetim kaydına işlenir.
      </p>

      {enabled === false && (
        <div className="card" style={{ borderLeft: "4px solid var(--warning, #f59e0b)" }}>
          <strong>Kayıt özelliği bu sunucuda etkin değil.</strong>
          <p className="hint-text" style={{ margin: 0 }}>
            Etkinleştirmek için sunucuda INTERCOM_RECORDING_DIR ortam değişkeni ayarlanmalıdır.
          </p>
        </div>
      )}

      <div className="card">
        <div className="toolbar">
          <strong>Saklama süresi</strong>
          <div className="spacer" />
          {canEditRetention ? (
            <>
              <input
                type="number"
                min={30}
                max={1825}
                value={retentionInput}
                onChange={(e) => setRetentionInput(e.target.value)}
                style={{ width: "6rem" }}
              />
              <span className="hint-text">gün</span>
              <button type="button" onClick={() => void saveRetention()} disabled={savingRetention}>
                Kaydet
              </button>
            </>
          ) : (
            <span>{retentionDays ?? "—"} gün</span>
          )}
        </div>
        <p className="hint-text" style={{ margin: 0 }}>
          Bu süreyi aşan kayıtlar hem diskten hem veritabanından otomatik olarak silinir (KVKK saklama süresi ilkesi).
        </p>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Kiosk</th>
              <th>Pompa</th>
              <th>Süre</th>
              <th>Boyut</th>
              <th>Dinle</th>
            </tr>
          </thead>
          <tbody>
            {recordings.map((r) => (
              <tr key={r.id}>
                <td>{formatDateTime(r.createdAt)}</td>
                <td>{r.kioskId ?? "—"}</td>
                <td>{r.pumpId ?? "—"}</td>
                <td>{formatDuration(r.startedAt, r.endedAt)}</td>
                <td className="hint-text">{(r.sizeBytes / 1024).toFixed(0)} KB</td>
                <td>
                  {playingId === r.id ? (
                    <audio controls autoPlay src={appendStationParam(`/api/intercom-recordings/${r.id}/audio`)} style={{ height: "2rem" }} />
                  ) : (
                    <button type="button" onClick={() => setPlayingId(r.id)}>
                      Oynat
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {recordings.length === 0 && (
              <tr>
                <td colSpan={6} className="hint-text">
                  Henüz kayıt yok.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div className="toolbar">
          <button type="button" onClick={() => loadPage(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>
            Önceki
          </button>
          <span className="hint-text">
            {offset + 1}-{Math.min(offset + PAGE_SIZE, total)} / {total}
          </span>
          <button type="button" onClick={() => loadPage(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}>
            Sonraki
          </button>
        </div>
      )}
    </div>
  );
}
