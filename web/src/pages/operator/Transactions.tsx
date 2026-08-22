import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useTopicSubscription } from "../../shared/useWebSocket";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { appendStationParam } from "../../shared/stationScope";
import { TRANSACTION_STATUS_LABEL, FUEL_LABEL, formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import type { Transaction } from "../../shared/types";

export default function Transactions() {
  const stationId = useEffectiveStationId();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);

  function load() {
    if (stationId === null) return;
    setLoading(true);
    const query = statusFilter ? `?status=${statusFilter}` : "";
    api.get<{ transactions: Transaction[] }>(`/api/transactions${query}`).then((res) => {
      setTransactions(res.transactions);
      setLoading(false);
    });
  }

  useEffect(load, [statusFilter, stationId]);

  useTopicSubscription(stationId !== null ? `transactions:${stationId}` : null, () => load());

  const csvHref = appendStationParam(`/api/transactions/export.csv${statusFilter ? `?status=${statusFilter}` : ""}`);

  return (
    <div>
      <h2>İşlem Listesi</h2>
      <div className="toolbar">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: 220 }}>
          <option value="">Tüm durumlar</option>
          {Object.entries(TRANSACTION_STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <div className="spacer" />
        <a href={csvHref}>
          <button>CSV Dışa Aktar</button>
        </a>
      </div>

      <div className="card">
        {loading ? (
          <p className="hint-text">Yükleniyor...</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th><th>Pompa</th><th>Plaka</th><th>Yakıt</th><th>Litre</th><th className="numeric">Tutar</th><th className="numeric">İndirim</th><th className="numeric">Puan</th><th>Durum</th><th>Oluşturulma</th><th>E-Fatura</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>{t.pumpId}</td>
                  <td>{t.plate}</td>
                  <td>{FUEL_LABEL[t.fuelType]}</td>
                  <td>{formatLiters(t.dispensedLiters)}</td>
                  <td className="numeric">
                    {formatCurrency(t.chargeAmount)}
                    {t.discountAmount > 0 && (
                      <div className="hint-text" style={{ marginTop: 0 }}>yakıt değeri: {formatCurrency(t.totalAmount)}</div>
                    )}
                  </td>
                  <td className="numeric">
                    {t.discountAmount > 0 ? (
                      <>
                        -{formatCurrency(t.discountAmount)}
                        {t.discountCode && <div className="hint-text" style={{ marginTop: 0 }}>{t.discountCode}</div>}
                      </>
                    ) : "-"}
                  </td>
                  <td className="numeric">
                    {t.loyaltyPointsRedeemed > 0 && <div style={{ color: "var(--warning)" }}>-{t.loyaltyPointsRedeemed}</div>}
                    {t.loyaltyPointsEarned > 0 && <div style={{ color: "var(--accent-2)" }}>+{t.loyaltyPointsEarned}</div>}
                    {t.loyaltyPointsRedeemed <= 0 && t.loyaltyPointsEarned <= 0 && "-"}
                  </td>
                  <td><span className={`badge ${t.status}`}>{TRANSACTION_STATUS_LABEL[t.status]}</span></td>
                  <td>{formatDateTime(t.createdAt)}</td>
                  <td>{t.status === "completed" && <InvoiceCell transactionId={t.id} />}</td>
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr><td colSpan={11} className="hint-text">Kayıt bulunamadı.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface InvoiceInfo {
  status: "pending" | "sent" | "failed";
  providerInvoiceId: string | null;
  errorMessage: string | null;
}

function InvoiceCell({ transactionId }: { transactionId: number }) {
  const [invoice, setInvoice] = useState<InvoiceInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<{ invoice: InvoiceInfo | null }>(`/api/transactions/${transactionId}/invoice`).then((res) => setInvoice(res.invoice));
  }
  useEffect(load, [transactionId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ invoice: InvoiceInfo }>(`/api/transactions/${transactionId}/invoice`);
      setInvoice(res.invoice);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Fatura oluşturulamadı.");
    } finally {
      setBusy(false);
    }
  }

  if (invoice === undefined) return <span className="hint-text">...</span>;

  if (invoice?.status === "sent") {
    return <span className="badge completed" title={invoice.providerInvoiceId ?? undefined}>Kesildi</span>;
  }

  return (
    <div>
      <button onClick={create} disabled={busy}>{busy ? "..." : "E-Fatura Oluştur"}</button>
      {error && <div className="error-text" style={{ fontSize: "0.75rem", maxWidth: 220 }}>{error}</div>}
      {!error && invoice?.status === "failed" && (
        <div className="error-text" style={{ fontSize: "0.75rem", maxWidth: 220 }}>{invoice.errorMessage}</div>
      )}
    </div>
  );
}
