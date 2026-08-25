import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { FUEL_LABEL, formatCurrency } from "../../shared/format";

interface SummaryResponse {
  totals: {
    transactionCount: number;
    totalRevenue: number;
    totalDiscount: number;
    totalLiters: number;
    completedCount: number;
    cancelledCount: number;
    failedCount: number;
  };
  byFuelType: Array<{
    fuelType: string;
    count: number;
    revenue: number;
    discount: number;
    grossRevenue: number;
    liters: number;
    avgCostPerLiter: number | null;
    estimatedGrossProfit: number | null;
  }>;
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

/**
 * Backend yalnizca satis olan gunleri dondurur; grafik her zaman tam 30 gunluk
 * bir zaman cizelgesi gostersin diye eksik gunler 0 degeriyle doldurulur. Aksi
 * halde (ör. tek gunluk veri varken) tek bir çubuk tum genisligi kaplayip
 * grafik degil duz bir dikdortgen gibi gorunuyordu.
 */
function buildLast30Days(byDay: SummaryResponse["byDay"]): SummaryResponse["byDay"] {
  const byDate = new Map(byDay.map((d) => [d.day, d]));
  const today = new Date();
  const result: SummaryResponse["byDay"] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    result.push(byDate.get(key) ?? { day: key, count: 0, revenue: 0 });
  }
  return result;
}

export default function Reports() {
  const stationId = useEffectiveStationId();
  const [data, setData] = useState<SummaryResponse | null>(null);

  useEffect(() => {
    if (stationId === null) return;
    api.get<SummaryResponse>("/api/reports/summary").then(setData);
  }, [stationId]);

  if (!data) return <p className="hint-text">Yükleniyor...</p>;

  const maxPumpRevenue = Math.max(1, ...data.byPump.map((d) => d.revenue));
  const avgTicket = data.totals.completedCount > 0 ? data.totals.totalRevenue / data.totals.completedCount : 0;
  const days = buildLast30Days(data.byDay);
  const maxDayRevenue = Math.max(1, ...days.map((d) => d.revenue));
  const avgDayRevenue = days.length > 0 ? days.reduce((sum, d) => sum + d.revenue, 0) / days.length : 0;
  const bestDay = days.reduce<SummaryResponse["byDay"][number] | null>((best, d) => (!best || d.revenue > best.revenue ? d : best), null);

  return (
    <div>
      <h2>Raporlama</h2>

      <div className="grid cols-5">
        <div className="card stat">
          <span className="label">Toplam Ciro</span>
          <span className="value">{formatCurrency(data.totals.totalRevenue)}</span>
          <span className="hint-text">Müşteriden tahsil edilen gerçek tutar (indirim düşülmüş)</span>
        </div>
        <div className="card stat">
          <span className="label">Toplam İndirim</span>
          <span className="value" style={{ color: "var(--warning)" }}>{formatCurrency(data.totals.totalDiscount)}</span>
          <span className="hint-text">Kampanya kodu + puan kullanımı</span>
        </div>
        <div className="card stat">
          <span className="label">Toplam Litre</span>
          <span className="value">{data.totals.totalLiters.toFixed(1)} L</span>
        </div>
        <div className="card stat">
          <span className="label">Ortalama İşlem Tutarı</span>
          <span className="value">{formatCurrency(avgTicket)}</span>
        </div>
        <div className="card stat">
          <span className="label">Tamamlanan / İptal / Başarısız</span>
          <span className="value" style={{ fontSize: "1.1rem" }}>
            {data.totals.completedCount} / {data.totals.cancelledCount} / {data.totals.failedCount}
          </span>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: "1rem" }}>
        <div className="card">
          <h3>Yakıt Tipine Göre</h3>
          <p className="hint-text" style={{ marginTop: 0 }}>
            Tahmini Kar: satılan litre × tankın güncel ortalama alış maliyeti kullanılarak hesaplanır (satış anındaki
            gerçek maliyet değil, yaklaşık bir değerdir). Bu yakıt tipi için hiç maliyet girilmemişse "-" gösterilir.
          </p>
          <table>
            <thead>
              <tr>
                <th>Yakıt</th>
                <th className="numeric">İşlem</th>
                <th className="numeric">Litre</th>
                <th className="numeric">Ort. Fiyat</th>
                <th className="numeric">İndirim</th>
                <th className="numeric">Ciro</th>
                <th className="numeric">Tahmini Kar</th>
                <th className="numeric">Pay</th>
              </tr>
            </thead>
            <tbody>
              {data.byFuelType.map((f) => (
                <tr key={f.fuelType}>
                  <td><span className={`fuel-dot ${f.fuelType}`} />{FUEL_LABEL[f.fuelType] ?? f.fuelType}</td>
                  <td className="numeric">{f.count}</td>
                  <td className="numeric">{f.liters.toFixed(1)} L</td>
                  <td className="numeric">{formatCurrency(f.liters > 0 ? f.grossRevenue / f.liters : 0)}</td>
                  <td className="numeric">{f.discount > 0 ? formatCurrency(f.discount) : "-"}</td>
                  <td className="numeric">{formatCurrency(f.revenue)}</td>
                  <td className="numeric" style={{ color: f.estimatedGrossProfit !== null && f.estimatedGrossProfit < 0 ? "var(--danger)" : undefined }}>
                    {f.estimatedGrossProfit !== null ? formatCurrency(f.estimatedGrossProfit) : "-"}
                  </td>
                  <td className="numeric"><span className="share-pill">{pct(f.revenue, data.totals.totalRevenue)}</span></td>
                </tr>
              ))}
              {data.byFuelType.length === 0 && <tr><td colSpan={8} className="hint-text">Veri yok.</td></tr>}
              {data.byFuelType.length > 0 && (
                <tr className="table-total">
                  <td>Toplam</td>
                  <td className="numeric">{data.byFuelType.reduce((s, f) => s + f.count, 0)}</td>
                  <td className="numeric">{data.byFuelType.reduce((s, f) => s + f.liters, 0).toFixed(1)} L</td>
                  <td className="hint-text-cell numeric">-</td>
                  <td className="numeric">{formatCurrency(data.byFuelType.reduce((s, f) => s + f.discount, 0))}</td>
                  <td className="numeric">{formatCurrency(data.byFuelType.reduce((s, f) => s + f.revenue, 0))}</td>
                  <td className="numeric">
                    {data.byFuelType.some((f) => f.estimatedGrossProfit !== null)
                      ? formatCurrency(data.byFuelType.reduce((s, f) => s + (f.estimatedGrossProfit ?? 0), 0))
                      : "-"}
                  </td>
                  <td className="numeric">%100.0</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Pompa Bazında Performans</h3>
          <table>
            <thead>
              <tr>
                <th>Pompa</th>
                <th className="numeric">İşlem</th>
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
          <h3 style={{ margin: 0 }}>Son 30 Gün</h3>
          <div className="spacer" />
          {bestDay && (
            <span className="hint-text">En yüksek: {formatDayLabel(bestDay.day)} ({formatCurrency(bestDay.revenue)})</span>
          )}
          <span className="hint-text">Günlük ortalama: {formatCurrency(avgDayRevenue)}</span>
        </div>
        <div className="report-day-chart">
          {days.map((d) => (
            <div key={d.day} className="report-day-bar-wrap" title={`${formatDayLabel(d.day)}: ${formatCurrency(d.revenue)} (${d.count} işlem)`}>
              <div className="report-day-bar" style={{ height: `${Math.max((d.revenue / maxDayRevenue) * 100, 1.5)}%` }} />
            </div>
          ))}
        </div>
        <div className="toolbar" style={{ marginTop: "0.5rem", marginBottom: 0, justifyContent: "space-between" }}>
          <span className="hint-text">{formatDayLabel(days[0]!.day)}</span>
          <span className="hint-text">{formatDayLabel(days[days.length - 1]!.day)}</span>
        </div>
      </div>
    </div>
  );
}
