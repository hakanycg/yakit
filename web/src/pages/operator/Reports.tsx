import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { FUEL_LABEL, formatCurrency } from "../../shared/format";

interface SummaryResponse {
  totals: {
    transactionCount: number;
    totalRevenue: number;
    totalLiters: number;
    completedCount: number;
    cancelledCount: number;
    failedCount: number;
  };
  byFuelType: Array<{ fuelType: string; count: number; revenue: number; liters: number }>;
  byDay: Array<{ day: string; count: number; revenue: number }>;
  byPump: Array<{ pumpNumber: number; count: number; revenue: number }>;
}

export default function Reports() {
  const [data, setData] = useState<SummaryResponse | null>(null);

  useEffect(() => {
    api.get<SummaryResponse>("/api/reports/summary").then(setData);
  }, []);

  if (!data) return <p className="hint-text">Yukleniyor...</p>;

  const maxDayRevenue = Math.max(1, ...data.byDay.map((d) => d.revenue));
  const maxPumpRevenue = Math.max(1, ...data.byPump.map((d) => d.revenue));

  return (
    <div>
      <h2>Raporlama</h2>

      <div className="grid cols-3">
        <div className="card stat">
          <span className="label">Toplam Ciro</span>
          <span className="value">{formatCurrency(data.totals.totalRevenue)}</span>
        </div>
        <div className="card stat">
          <span className="label">Toplam Litre</span>
          <span className="value">{data.totals.totalLiters.toFixed(1)} L</span>
        </div>
        <div className="card stat">
          <span className="label">Tamamlanan / Iptal / Basarisiz</span>
          <span className="value" style={{ fontSize: "1.1rem" }}>
            {data.totals.completedCount} / {data.totals.cancelledCount} / {data.totals.failedCount}
          </span>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: "1rem" }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Yakit Tipine Gore</h3>
          <table>
            <thead><tr><th>Yakit</th><th>Islem</th><th>Litre</th><th>Ciro</th></tr></thead>
            <tbody>
              {data.byFuelType.map((f) => (
                <tr key={f.fuelType}>
                  <td>{FUEL_LABEL[f.fuelType] ?? f.fuelType}</td>
                  <td>{f.count}</td>
                  <td>{f.liters.toFixed(1)} L</td>
                  <td>{formatCurrency(f.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Pompa Bazinda Ciro</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {data.byPump.map((p) => (
              <div key={p.pumpNumber}>
                <div className="toolbar" style={{ margin: 0 }}>
                  <span>Pompa {p.pumpNumber}</span>
                  <div className="spacer" />
                  <span className="hint-text">{formatCurrency(p.revenue)}</span>
                </div>
                <div style={{ background: "var(--panel-2)", borderRadius: 6, overflow: "hidden", height: 10 }}>
                  <div style={{ width: `${(p.revenue / maxPumpRevenue) * 100}%`, background: "var(--accent)", height: "100%" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Son 30 Gun</h3>
        <div style={{ display: "flex", alignItems: "flex-end", gap: "0.4rem", height: 140 }}>
          {[...data.byDay].reverse().map((d) => (
            <div key={d.day} title={`${d.day}: ${formatCurrency(d.revenue)}`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
              <div style={{ background: "var(--accent-2)", height: `${(d.revenue / maxDayRevenue) * 100}%`, borderRadius: "3px 3px 0 0", minHeight: 2 }} />
            </div>
          ))}
          {data.byDay.length === 0 && <p className="hint-text">Veri yok.</p>}
        </div>
      </div>
    </div>
  );
}
