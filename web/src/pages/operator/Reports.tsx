import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
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
  byPump: Array<{ pumpNumber: number; count: number; revenue: number; liters: number }>;
}

function formatDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short" }).format(d);
}

function pct(part: number, total: number): string {
  if (total <= 0) return "%0";
  return `%${((part / total) * 100).toFixed(1)}`;
}

export default function Reports() {
  const stationId = useEffectiveStationId();
  const [data, setData] = useState<SummaryResponse | null>(null);

  useEffect(() => {
    if (stationId === null) return;
    api.get<SummaryResponse>("/api/reports/summary").then(setData);
  }, [stationId]);

  if (!data) return <p className="hint-text">Yukleniyor...</p>;

  const maxDayRevenue = Math.max(1, ...data.byDay.map((d) => d.revenue));
  const maxPumpRevenue = Math.max(1, ...data.byPump.map((d) => d.revenue));
  const avgTicket = data.totals.completedCount > 0 ? data.totals.totalRevenue / data.totals.completedCount : 0;
  const days = [...data.byDay].reverse();
  const avgDayRevenue = days.length > 0 ? days.reduce((sum, d) => sum + d.revenue, 0) / days.length : 0;
  const bestDay = days.reduce<SummaryResponse["byDay"][number] | null>((best, d) => (!best || d.revenue > best.revenue ? d : best), null);

  return (
    <div>
      <h2>Raporlama</h2>

      <div className="grid cols-4">
        <div className="card stat">
          <span className="label">Toplam Ciro</span>
          <span className="value">{formatCurrency(data.totals.totalRevenue)}</span>
        </div>
        <div className="card stat">
          <span className="label">Toplam Litre</span>
          <span className="value">{data.totals.totalLiters.toFixed(1)} L</span>
        </div>
        <div className="card stat">
          <span className="label">Ortalama Islem Tutari</span>
          <span className="value">{formatCurrency(avgTicket)}</span>
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
            <thead>
              <tr>
                <th>Yakit</th>
                <th className="numeric">Islem</th>
                <th className="numeric">Litre</th>
                <th className="numeric">Ort. Fiyat</th>
                <th className="numeric">Ciro</th>
                <th className="numeric">Pay</th>
              </tr>
            </thead>
            <tbody>
              {data.byFuelType.map((f) => (
                <tr key={f.fuelType}>
                  <td><span className={`fuel-dot ${f.fuelType}`} />{FUEL_LABEL[f.fuelType] ?? f.fuelType}</td>
                  <td className="numeric">{f.count}</td>
                  <td className="numeric">{f.liters.toFixed(1)} L</td>
                  <td className="numeric">{formatCurrency(f.liters > 0 ? f.revenue / f.liters : 0)}</td>
                  <td className="numeric">{formatCurrency(f.revenue)}</td>
                  <td className="numeric"><span className="share-pill">{pct(f.revenue, data.totals.totalRevenue)}</span></td>
                </tr>
              ))}
              {data.byFuelType.length === 0 && <tr><td colSpan={6} className="hint-text">Veri yok.</td></tr>}
              {data.byFuelType.length > 0 && (
                <tr className="table-total">
                  <td>Toplam</td>
                  <td className="numeric">{data.byFuelType.reduce((s, f) => s + f.count, 0)}</td>
                  <td className="numeric">{data.byFuelType.reduce((s, f) => s + f.liters, 0).toFixed(1)} L</td>
                  <td className="hint-text-cell numeric">-</td>
                  <td className="numeric">{formatCurrency(data.byFuelType.reduce((s, f) => s + f.revenue, 0))}</td>
                  <td className="numeric">%100.0</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Pompa Bazinda Performans</h3>
          <table>
            <thead>
              <tr>
                <th>Pompa</th>
                <th className="numeric">Islem</th>
                <th className="numeric">Litre</th>
                <th className="numeric">Ciro</th>
                <th>Pay</th>
              </tr>
            </thead>
            <tbody>
              {data.byPump.map((p) => (
                <tr key={p.pumpNumber}>
                  <td>Pompa {p.pumpNumber}</td>
                  <td className="numeric">{p.count}</td>
                  <td className="numeric">{p.liters.toFixed(1)} L</td>
                  <td className="numeric">{formatCurrency(p.revenue)}</td>
                  <td className="report-bar-cell">
                    <div className="report-bar-track">
                      <div className="report-bar-fill" style={{ width: `${(p.revenue / maxPumpRevenue) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
              {data.byPump.length === 0 && <tr><td colSpan={5} className="hint-text">Veri yok.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
          <h3 style={{ margin: 0 }}>Son 30 Gun</h3>
          <div className="spacer" />
          {bestDay && (
            <span className="hint-text">En yuksek: {formatDayLabel(bestDay.day)} ({formatCurrency(bestDay.revenue)})</span>
          )}
          <span className="hint-text">Gunluk ortalama: {formatCurrency(avgDayRevenue)}</span>
        </div>
        <div className="report-day-chart">
          {days.map((d) => (
            <div key={d.day} className="report-day-bar-wrap" title={`${formatDayLabel(d.day)}: ${formatCurrency(d.revenue)} (${d.count} islem)`}>
              <div className="report-day-bar" style={{ height: `${Math.max((d.revenue / maxDayRevenue) * 100, 1.5)}%` }} />
            </div>
          ))}
          {days.length === 0 && <p className="hint-text">Veri yok.</p>}
        </div>
        {days.length > 0 && (
          <div className="toolbar" style={{ marginTop: "0.5rem", marginBottom: 0, justifyContent: "space-between" }}>
            <span className="hint-text">{formatDayLabel(days[0]!.day)}</span>
            <span className="hint-text">{formatDayLabel(days[days.length - 1]!.day)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
