import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatCurrency } from "../../shared/format";

interface VatSummary {
  from: string | null;
  to: string | null;
  outputVatBase: number;
  outputVat: number;
  inputVatBase: number;
  inputVat: number;
  netVat: number;
}

export default function VatSummary() {
  const stationId = useEffectiveStationId();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [summary, setSummary] = useState<VatSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stationId === null) return;
    const params = new URLSearchParams();
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    api
      .get<{ summary: VatSummary }>(`/api/vat-summary?${params.toString()}`)
      .then((res) => setSummary(res.summary))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Özet yüklenemedi."));
  }, [stationId, dateFrom, dateTo]);

  const payable = summary !== null && summary.netVat > 0;

  return (
    <div>
      <h2>KDV Özet Raporu</h2>
      <p className="hint-text">
        Hesaplanan KDV (satış), yakıt satış gelirinin KDV dahil olmasından geriye hesaplanır. İndirilecek KDV (alım/gider)
        rakamı ise yakıt maliyeti ve genel giderlerin de %20 KDV dahil olduğu varsayımıyla TAHMİNİ hesaplanmıştır — resmi
        KDV beyannamesi için muhasebecinize danışın.
      </p>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="toolbar">
          <label htmlFor="vat-date-from" style={{ margin: 0 }}>
            Başlangıç
          </label>
          <input id="vat-date-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ maxWidth: 170 }} />
          <label htmlFor="vat-date-to" style={{ margin: 0 }}>
            Bitiş
          </label>
          <input id="vat-date-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ maxWidth: 170 }} />
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {summary && (
        <div className="grid stats-grid">
          <div className="card stat dash-stat">
            <div className="stat-body">
              <span className="label">Hesaplanan KDV</span>
              <span className="value">{formatCurrency(summary.outputVat)}</span>
              <span className="stat-caption">{formatCurrency(summary.outputVatBase)} KDV dahil satış geliri üzerinden</span>
            </div>
          </div>

          <div className="card stat dash-stat">
            <div className="stat-body">
              <span className="label">İndirilecek KDV (tahmini)</span>
              <span className="value">{formatCurrency(summary.inputVat)}</span>
              <span className="stat-caption">{formatCurrency(summary.inputVatBase)} yakıt maliyeti + genel gider üzerinden</span>
            </div>
          </div>

          <div className="card stat dash-stat">
            <div className="stat-body">
              <span className="label">Net KDV</span>
              <span className="value" style={payable ? { color: "#f87171" } : undefined}>
                {formatCurrency(Math.abs(summary.netVat))}
              </span>
              <span className={`badge ${payable ? "critical" : "resolved"}`}>{payable ? "Ödenecek KDV" : "Devreden KDV"}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
