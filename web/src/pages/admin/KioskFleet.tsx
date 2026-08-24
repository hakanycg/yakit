import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { formatDateTime } from "../../shared/format";
import { AlertIcon, CheckCircleIcon, SyncIcon } from "../../shared/icons";
import type { FleetKiosk, KioskFleetSummary, KioskHealthStatus } from "../../shared/types";

/**
 * Kiosk filosu: tum istasyonlardaki fiziksel kiosk bilgisayarlarinin tek ekranda
 * saglik gorunumu. Yuzlerce kiosk isletirken "hangi ekran su an calismiyor"
 * sorusu istasyon kartlarini tek tek acarak cevaplanamaz.
 */

const STATUS_LABEL: Record<KioskHealthStatus, string> = {
  online: "Çevrimiçi",
  offline: "Çevrimdışı",
  never_seen: "Kurulum bekliyor",
};

const STATUS_BADGE: Record<KioskHealthStatus, string> = {
  online: "resolved",
  offline: "critical",
  never_seen: "warning",
};

/** Kiosk ekrani dakikada bir kalp atisi gonderir; bu esik onun cok uzerindedir. */
function lastSeenText(k: FleetKiosk): string {
  if (!k.lastSeenAt) return "Hiç bağlanmadı";
  if (k.status === "offline" && k.offlineMinutes !== null) {
    const h = Math.floor(k.offlineMinutes / 60);
    return h > 0
      ? `${h} saat ${k.offlineMinutes % 60} dk önce`
      : `${k.offlineMinutes} dk önce`;
  }
  return formatDateTime(k.lastSeenAt);
}

export default function KioskFleet() {
  const [kiosks, setKiosks] = useState<FleetKiosk[]>([]);
  const [summary, setSummary] = useState<KioskFleetSummary | null>(null);
  const [status, setStatus] = useState<"" | KioskHealthStatus>("");
  const [q, setQ] = useState("");

  function load() {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (q.trim()) params.set("q", q.trim());
    const query = params.toString();
    api
      .get<{ kiosks: FleetKiosk[]; summary: KioskFleetSummary }>(`/api/kiosk-fleet${query ? `?${query}` : ""}`)
      .then((res) => {
        setKiosks(res.kiosks);
        setSummary(res.summary);
      });
  }

  useEffect(load, [status, q]);

  // Ekran acik birakildiginda kendini tazeler; filo durumu dakikalar icinde degisir.
  useEffect(() => {
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [status, q]);

  return (
    <div>
      <h2>Kiosk Filosu</h2>
      <p className="hint-text">
        Tüm istasyonlardaki fiziksel kiosk bilgisayarları. Her kiosk dakikada
        bir kalp atışı gönderir; çevrimdışı kalan bir kiosk, o adada satış
        yapılamıyor demektir.
      </p>

      <div className="grid stats-grid">
        <FleetStat
          label="Çevrimiçi"
          value={summary ? `${summary.online} / ${summary.total}` : "..."}
          caption="Son 10 dakikada bağlandı"
          tone="ok"
        />
        <FleetStat
          label="Çevrimdışı"
          value={summary ? String(summary.offline) : "..."}
          caption="Bağlantı kesildi — müdahale gerekli"
          tone={summary && summary.offline > 0 ? "bad" : "ok"}
        />
        <FleetStat
          label="Kurulum bekliyor"
          value={summary ? String(summary.neverSeen) : "..."}
          caption="Kaydı açıldı, cihaza henüz uygulanmadı"
          tone="neutral"
        />
        <FleetStat
          label="Donanım arızası"
          value={summary ? String(summary.stationsWithFault) : "..."}
          caption="Açık yazıcı/ÖKC alarmı olan istasyon"
          tone={summary && summary.stationsWithFault > 0 ? "bad" : "ok"}
        />
      </div>

      <div className="toolbar">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Kiosk, istasyon, kod veya AnyDesk ID ile ara..."
          aria-label="Kiosk ara"
          style={{ flex: "1 1 260px", minWidth: 0 }}
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as "" | KioskHealthStatus)}
          aria-label="Durum filtresi"
          style={{ width: 200 }}
        >
          <option value="">Tüm durumlar</option>
          <option value="online">Çevrimiçi</option>
          <option value="offline">Çevrimdışı</option>
          <option value="never_seen">Kurulum bekliyor</option>
        </select>
        <a href="/api/kiosk-fleet/export.csv">
          <button type="button">CSV İndir</button>
        </a>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kiosk</th>
                <th>İstasyon</th>
                <th>Durum</th>
                <th>Son bağlantı</th>
                <th>AnyDesk</th>
                <th>Uyarı</th>
              </tr>
            </thead>
            <tbody>
              {kiosks.map((k) => (
                <tr key={k.id}>
                  <td>
                    <strong>{k.label}</strong>
                    <div className="hint-text">#{k.id}</div>
                  </td>
                  <td>
                    {k.stationName}
                    <div className="hint-text">
                      <code>{k.stationCode ?? "—"}</code>
                      {!k.stationActive && " · pasif"}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[k.status]}`}>{STATUS_LABEL[k.status]}</span>
                  </td>
                  <td>{lastSeenText(k)}</td>
                  <td>
                    {k.anydeskId ? <code>{k.anydeskId}</code> : <span className="hint-text">—</span>}
                  </td>
                  <td>
                    {k.stationFaultAlarms > 0 ? (
                      <span className="badge critical">{k.stationFaultAlarms} donanım arızası</span>
                    ) : (
                      <span className="hint-text">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {kiosks.length === 0 && (
                <tr>
                  <td colSpan={6} className="hint-text">
                    {q || status ? "Bu filtreye uyan kiosk yok." : "Henüz kiosk eklenmemiş. İstasyonlar sayfasından ekleyebilirsiniz."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FleetStat({
  label,
  value,
  caption,
  tone,
}: {
  label: string;
  value: string;
  caption: string;
  tone: "ok" | "bad" | "neutral";
}) {
  const palette = {
    ok: { background: "rgba(34,197,94,0.15)", color: "#4ade80" },
    bad: { background: "rgba(248,113,113,0.15)", color: "#f87171" },
    neutral: { background: "rgba(58,160,255,0.15)", color: "var(--accent)" },
  }[tone];

  return (
    <div className="card stat dash-stat">
      <div className="stat-icon" style={palette}>
        {tone === "bad" ? (
          <AlertIcon />
        ) : tone === "ok" ? (
          <CheckCircleIcon />
        ) : (
          <SyncIcon />
        )}
      </div>
      <div className="stat-body">
        <span className="label">{label}</span>
        <span
          className="value"
          style={tone === "bad" ? { color: "#f87171" } : undefined}
        >
          {value}
        </span>
        <span className="stat-caption">{caption}</span>
      </div>
    </div>
  );
}
