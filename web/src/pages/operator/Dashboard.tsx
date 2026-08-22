import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePumps, useActiveAlarms } from "../../shared/hooks";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useAuth } from "../../shared/AuthContext";
import { api } from "../../shared/api";
import { PUMP_STATUS_LABEL, FUEL_LABEL, formatCurrency } from "../../shared/format";

interface SyncStatus {
  lastHeartbeatAt: string | null;
  lastSyncedAt: string | null;
  agentConfigured: boolean;
}

function SyncStatusCard() {
  const stationId = useEffectiveStationId();
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    if (stationId === null) return;
    api.get<SyncStatus>("/api/sync/status").then(setStatus).catch(() => setStatus(null));
  }, [stationId]);

  if (!status) return null;

  let label = "İstasyon ajanı kurulmadı";
  let color: string | undefined;
  if (status.agentConfigured && status.lastHeartbeatAt) {
    const minutesAgo = (Date.now() - new Date(status.lastHeartbeatAt).getTime()) / 60000;
    label = minutesAgo < 5 ? "Senkron: az önce" : `Senkron: ${Math.round(minutesAgo)} dk önce`;
    color = minutesAgo >= 15 ? "#f87171" : minutesAgo >= 5 ? "#e0b96a" : undefined;
  }

  return (
    <div className="card stat dash-stat">
      <div className="stat-icon" style={{ background: "rgba(167,139,250,0.15)", color: "#a78bfa" }}>🔄</div>
      <div className="stat-body">
        <span className="label">İstasyon Ajanı</span>
        <span className="value" style={{ fontSize: "1rem", fontWeight: 600, color }}>{label}</span>
      </div>
    </div>
  );
}

const GREETINGS = [
  { maxHour: 6, text: "İyi geceler" },
  { maxHour: 12, text: "Günaydın" },
  { maxHour: 18, text: "İyi günler" },
  { maxHour: 24, text: "İyi akşamlar" },
];

function getGreeting(hour: number): string {
  return (GREETINGS.find((g) => hour < g.maxHour) ?? GREETINGS[GREETINGS.length - 1]).text;
}

interface DayPoint {
  day: string;
  count: number;
  revenue: number;
}

interface Summary {
  totals: {
    transactionCount: number;
    totalRevenue: number;
    totalLiters: number;
    completedCount: number;
    cancelledCount: number;
    failedCount: number;
  };
  byDay: DayPoint[];
}

/** API en yeni gunu once dondurur (DESC); grafik icin kronolojik siraya cevirip basit bir alan/cizgi grafik ciziyoruz. Harici kutuphane kullanilmiyor. */
function RevenueTrendChart({ data }: { data: DayPoint[] }) {
  const points = [...data].reverse();
  if (points.length < 2) {
    return <p className="hint-text">Grafik için yeterli veri yok (en az 2 günlük satış gerekiyor).</p>;
  }

  const width = 600;
  const height = 160;
  const pad = 10;
  const max = Math.max(...points.map((p) => p.revenue), 1);
  const stepX = (width - pad * 2) / (points.length - 1);
  const coords = points.map((p, i) => ({
    x: pad + i * stepX,
    y: height - pad - (p.revenue / max) * (height - pad * 2),
    p,
  }));
  const linePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const areaPoints = `${pad},${height - pad} ${linePoints} ${width - pad},${height - pad}`;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "160px", display: "block" }} preserveAspectRatio="none">
        <polygon points={areaPoints} fill="rgba(96,165,250,0.15)" />
        <polyline points={linePoints} fill="none" stroke="#60a5fa" strokeWidth="2" />
        {coords.map((c) => (
          <circle key={c.p.day} cx={c.x} cy={c.y} r="3" fill="#60a5fa">
            <title>{`${c.p.day}: ${formatCurrency(c.p.revenue)} (${c.p.count} işlem)`}</title>
          </circle>
        ))}
      </svg>
      <div className="toolbar hint-text" style={{ marginTop: "0.4rem" }}>
        <span>{points[0].day}</span>
        <div className="spacer" />
        <span>{points[points.length - 1].day}</span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { pumps } = usePumps();
  const { alarms } = useActiveAlarms();
  const { user } = useAuth();
  const stationId = useEffectiveStationId();
  const [summary, setSummary] = useState<Summary | null>(null);
  const canSeeSyncStatus = user?.role === "admin" || user?.role === "super_admin";

  useEffect(() => {
    if (stationId === null) return;
    api.get<Summary>("/api/reports/summary").then(setSummary);
  }, [stationId]);

  const dispensing = pumps.filter((p) => p.status === "dispensing").length;
  const faulty = pumps.filter((p) => p.status === "fault").length;
  const today = new Date();
  const todayLabel = today.toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <div>
      <div className="dash-welcome">
        <p className="eyebrow">Genel Bakış</p>
        <h2>{getGreeting(today.getHours())}, {user?.displayName ?? ""} 👋</h2>
        <p className="hint-text">{todayLabel} · İşletmenizin güncel durumu: ciro, dolum ve alarm özeti.</p>
      </div>
      <div className="grid stats-grid">
        <div className="card stat dash-stat">
          <div className="stat-icon" style={{ background: "rgba(58,160,255,0.15)", color: "var(--accent)" }}>💰</div>
          <div className="stat-body">
            <span className="label">Toplam Ciro</span>
            <span className="value">{summary ? formatCurrency(summary.totals.totalRevenue) : "..."}</span>
            <span className="stat-caption">İstasyonun tüm zamanlar tahsilatı</span>
          </div>
        </div>
        <div className="card stat dash-stat">
          <div className="stat-icon" style={{ background: "rgba(34,197,94,0.15)", color: "#4ade80" }}>✅</div>
          <div className="stat-body">
            <span className="label">Tamamlanan İşlem</span>
            <span className="value">{summary?.totals.completedCount ?? "..."}</span>
            <span className="stat-caption">Başarıyla tamamlanan toplam satış</span>
          </div>
        </div>
        <div className="card stat dash-stat">
          <div className="stat-icon" style={{ background: "rgba(58,160,255,0.15)", color: "var(--accent)" }}>⛽</div>
          <div className="stat-body">
            <span className="label">Aktif Dolum</span>
            <span className="value">{dispensing} / {pumps.length}</span>
            <span className="stat-caption">Şu anda dolum yapan pompa sayısı</span>
          </div>
        </div>
        <div className="card stat dash-stat">
          <div className="stat-icon" style={{ background: alarms.length ? "rgba(248,113,113,0.15)" : "rgba(139,152,165,0.15)", color: alarms.length ? "#f87171" : "var(--text-dim)" }}>🚨</div>
          <div className="stat-body">
            <span className="label">Aktif Alarm</span>
            <span className="value" style={{ color: alarms.length ? "#f87171" : undefined }}>{alarms.length}</span>
            <span className="stat-caption">Anlık çözülmemiş alarm sayısı</span>
          </div>
        </div>
        {canSeeSyncStatus && <SyncStatusCard />}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Son 30 Gün Ciro Trendi</h3>
        {summary ? <RevenueTrendChart data={summary.byDay} /> : <p className="hint-text">Yükleniyor...</p>}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="toolbar">
          <h3 style={{ margin: 0 }}>Pompa Durumu</h3>
          <div className="spacer" />
          <Link to="/operator/pompalar"><button className="ghost">Tümünü gör</button></Link>
        </div>
        <div className="grid cols-4">
          {pumps.map((p) => (
            <div className="card pump-mini-card" key={p.id}>
              <div className="toolbar" style={{ marginBottom: "0.4rem" }}>
                <strong>{p.label}</strong>
                <span className={`badge ${p.status}`}>{PUMP_STATUS_LABEL[p.status]}</span>
              </div>
              <p className="hint-text" style={{ margin: 0 }}>{p.fuelTypes.map((f) => FUEL_LABEL[f]).join(", ")}</p>
              {faulty > 0 && p.status === "fault" && <p className="error-text">{p.faultMessage}</p>}
            </div>
          ))}
        </div>
      </div>

      {alarms.length > 0 && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>Aktif Alarmlar</h3>
          <table>
            <thead>
              <tr><th>Önem</th><th>Mesaj</th><th>Zaman</th></tr>
            </thead>
            <tbody>
              {alarms.slice(0, 5).map((a) => (
                <tr key={a.id}>
                  <td><span className={`badge ${a.severity}`}>{a.severity}</span></td>
                  <td>{a.message}</td>
                  <td>{new Date(a.createdAt).toLocaleTimeString("tr-TR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
