import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePumps, useActiveAlarms } from "../../shared/hooks";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { api } from "../../shared/api";
import { PUMP_STATUS_LABEL, FUEL_LABEL, formatCurrency } from "../../shared/format";

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
    return <p className="hint-text">Grafik icin yeterli veri yok (en az 2 gunluk satis gerekiyor).</p>;
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
            <title>{`${c.p.day}: ${formatCurrency(c.p.revenue)} (${c.p.count} islem)`}</title>
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
  const stationId = useEffectiveStationId();
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    if (stationId === null) return;
    api.get<Summary>("/api/reports/summary").then(setSummary);
  }, [stationId]);

  const dispensing = pumps.filter((p) => p.status === "dispensing").length;
  const faulty = pumps.filter((p) => p.status === "fault").length;

  return (
    <div>
      <h2>Panel</h2>
      <div className="grid cols-4">
        <div className="card stat">
          <span className="label">Toplam Ciro</span>
          <span className="value">{summary ? formatCurrency(summary.totals.totalRevenue) : "..."}</span>
        </div>
        <div className="card stat">
          <span className="label">Tamamlanan Islem</span>
          <span className="value">{summary?.totals.completedCount ?? "..."}</span>
        </div>
        <div className="card stat">
          <span className="label">Aktif Dolum</span>
          <span className="value">{dispensing} / {pumps.length}</span>
        </div>
        <div className="card stat">
          <span className="label">Aktif Alarm</span>
          <span className="value" style={{ color: alarms.length ? "#f87171" : undefined }}>{alarms.length}</span>
        </div>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Son 30 Gun Ciro Trendi</h3>
        {summary ? <RevenueTrendChart data={summary.byDay} /> : <p className="hint-text">Yukleniyor...</p>}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="toolbar">
          <h3 style={{ margin: 0 }}>Pompa Durumu</h3>
          <div className="spacer" />
          <Link to="/operator/pompalar"><button className="ghost">Tumunu gor</button></Link>
        </div>
        <div className="grid cols-4">
          {pumps.map((p) => (
            <div className="card" key={p.id}>
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
              <tr><th>Onem</th><th>Mesaj</th><th>Zaman</th></tr>
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
