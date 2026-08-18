import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { useTopicSubscription } from "../../shared/useWebSocket";
import { TRANSACTION_STATUS_LABEL, FUEL_LABEL, formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import type { Transaction } from "../../shared/types";
import { useAuth } from "../../shared/AuthContext";

export default function Transactions() {
  const { user } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    const query = statusFilter ? `?status=${statusFilter}` : "";
    api.get<{ transactions: Transaction[] }>(`/api/transactions${query}`).then((res) => {
      setTransactions(res.transactions);
      setLoading(false);
    });
  }

  useEffect(load, [statusFilter]);

  useTopicSubscription(user ? "transactions" : null, () => load());

  return (
    <div>
      <h2>Islem Listesi</h2>
      <div className="toolbar">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: 220 }}>
          <option value="">Tum durumlar</option>
          {Object.entries(TRANSACTION_STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <div className="spacer" />
        <a href={`/api/transactions/export.csv${statusFilter ? `?status=${statusFilter}` : ""}`}>
          <button>CSV Disa Aktar</button>
        </a>
      </div>

      <div className="card">
        {loading ? (
          <p className="hint-text">Yukleniyor...</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th><th>Pompa</th><th>Plaka</th><th>Yakit</th><th>Litre</th><th>Tutar</th><th>Durum</th><th>Olusturulma</th>
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
                  <td>{formatCurrency(t.totalAmount)}</td>
                  <td><span className={`badge ${t.status}`}>{TRANSACTION_STATUS_LABEL[t.status]}</span></td>
                  <td>{formatDateTime(t.createdAt)}</td>
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr><td colSpan={8} className="hint-text">Kayit bulunamadi.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
