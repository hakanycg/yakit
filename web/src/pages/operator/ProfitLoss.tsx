import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatCurrency } from "../../shared/format";

interface ProfitLossSummary {
  from: string | null;
  to: string | null;
  revenue: number;
  discount: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number | null;
  expenses: number;
  netProfit: number;
  netMarginPct: number | null;
}

function formatPct(pct: number | null): string {
  return pct === null ? "—" : `%${pct.toFixed(1)}`;
}

export default function ProfitLoss() {
  const stationId = useEffectiveStationId();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [summary, setSummary] = useState<ProfitLossSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stationId === null) return;
    const params = new URLSearchParams();
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    api
      .get<{ summary: ProfitLossSummary }>(`/api/profit-loss?${params.toString()}`)
      .then((res) => setSummary(res.summary))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Özet yüklenemedi."));
  }, [stationId, dateFrom, dateTo]);

  return (
    <div>
      <h2>Gelir-Gider Özeti</h2>
      <p className="hint-text">
        Yakıt satış geliri, yakıt alım maliyeti ve genel giderlerin seçilen tarih aralığı için tek özeti. Tedarikçi cari
        hesabındaki borç bakiyesinden farklıdır: burada gösterilen maliyet bu aralıkta gerçekleşen alımlardır, halen
        ödenmemiş borç değildir.
      </p>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="toolbar">
          <label htmlFor="pl-date-from" style={{ margin: 0 }}>
            Başlangıç
          </label>
          <input id="pl-date-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ maxWidth: 170 }} />
          <label htmlFor="pl-date-to" style={{ margin: 0 }}>
            Bitiş
          </label>
          <input id="pl-date-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ maxWidth: 170 }} />
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {summary && (
        <div className="grid stats-grid">
          <div className="card stat dash-stat">
            <div className="stat-body">
              <span className="label">Toplam Gelir</span>
              <span className="value">{formatCurrency(summary.revenue)}</span>
              <span className="stat-caption">{formatCurrency(summary.discount)} indirim/puan düşülmüş</span>
            </div>
          </div>

          <div className="card stat dash-stat">
            <div className="stat-body">
              <span className="label">Yakıt Maliyeti</span>
              <span className="value">{formatCurrency(summary.cogs)}</span>
              <span className="stat-caption">Bu aralıkta gerçekleşen maliyetlendirilmiş teslimatlar</span>
            </div>
          </div>

          <div className="card stat dash-stat">
            <div className="stat-body">
              <span className="label">Brüt Kâr</span>
              <span className="value" style={summary.grossProfit < 0 ? { color: "#f87171" } : undefined}>
                {formatCurrency(summary.grossProfit)}
              </span>
              <span className={`badge ${summary.grossProfit < 0 ? "critical" : "resolved"}`}>
                Marj {formatPct(summary.grossMarginPct)}
              </span>
            </div>
          </div>

          <div className="card stat dash-stat">
            <div className="stat-body">
              <span className="label">Genel Giderler</span>
              <span className="value">{formatCurrency(summary.expenses)}</span>
              <span className="stat-caption">Elektrik, kira, personel vb. (Genel Gider Takibi)</span>
            </div>
          </div>

          <div className="card stat dash-stat">
            <div className="stat-body">
              <span className="label">Net Kâr</span>
              <span className="value" style={summary.netProfit < 0 ? { color: "#f87171" } : undefined}>
                {formatCurrency(summary.netProfit)}
              </span>
              <span className={`badge ${summary.netProfit < 0 ? "critical" : "resolved"}`}>
                Marj {formatPct(summary.netMarginPct)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
