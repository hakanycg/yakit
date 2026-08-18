import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePumps, useActiveAlarms } from "../../shared/hooks";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { api } from "../../shared/api";
import { PUMP_STATUS_LABEL, FUEL_LABEL, formatCurrency } from "../../shared/format";

interface Summary {
  totals: {
    transactionCount: number;
    totalRevenue: number;
    totalLiters: number;
    completedCount: number;
    cancelledCount: number;
    failedCount: number;
  };
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
