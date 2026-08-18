import { formatCurrency, formatLiters, TRANSACTION_STATUS_LABEL } from "../../shared/format";
import type { Transaction } from "../../shared/types";

export default function DispenseStep({ transaction, targetLiters }: { transaction: Transaction; targetLiters: number }) {
  const percent = targetLiters > 0 ? Math.min(100, (transaction.dispensedLiters / targetLiters) * 100) : 0;
  const waiting = transaction.status === "authorized";

  return (
    <div>
      <h2>{waiting ? "Pompa Yetkilendiriliyor..." : "Dolum Yapiliyor"}</h2>
      <p className="hint-text">Plaka: {transaction.plate} — Pompa #{transaction.pumpId}</p>

      <div className="progress-bar" style={{ margin: "1.5rem 0" }}>
        <div className="fill" style={{ width: `${waiting ? 0 : percent}%` }} />
      </div>

      <div className="grid cols-2">
        <div className="stat">
          <span className="label">Dolum Miktari</span>
          <span className="value">{formatLiters(transaction.dispensedLiters)}</span>
        </div>
        <div className="stat">
          <span className="label">Anlik Tutar</span>
          <span className="value">{formatCurrency(transaction.totalAmount)}</span>
        </div>
      </div>

      <p className="hint-text" style={{ marginTop: "1.5rem" }}>
        Lutfen bekleyin, dolum tamamlaninca islem otomatik olarak sonuclanacaktir. Durum: {TRANSACTION_STATUS_LABEL[transaction.status] ?? transaction.status}
      </p>
    </div>
  );
}
