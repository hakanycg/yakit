import { FUEL_LABEL, formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import type { Transaction } from "../../shared/types";

export default function ReceiptStep({ transaction, onRestart }: { transaction: Transaction; onRestart: () => void }) {
  const failed = transaction.status === "failed" || transaction.status === "cancelled";

  return (
    <div style={{ textAlign: "center" }}>
      <h2>{failed ? "Islem Tamamlanamadi" : "Islem Tamamlandi"}</h2>
      {failed ? (
        <p className="error-text">{transaction.cancelledReason ?? "Islem iptal edildi."}</p>
      ) : (
        <>
          <p className="hint-text">Aracinizin yakit dolumu basariyla tamamlandi.</p>
          <div className="card" style={{ textAlign: "left", maxWidth: 380, margin: "1.5rem auto" }}>
            <div className="toolbar"><span>Plaka</span><div className="spacer" /><strong>{transaction.plate}</strong></div>
            <div className="toolbar"><span>Yakit</span><div className="spacer" /><strong>{FUEL_LABEL[transaction.fuelType]}</strong></div>
            <div className="toolbar"><span>Miktar</span><div className="spacer" /><strong>{formatLiters(transaction.dispensedLiters)}</strong></div>
            <div className="toolbar"><span>Litre Fiyati</span><div className="spacer" /><strong>{formatCurrency(transaction.pricePerLiter)}</strong></div>
            <div className="toolbar"><span>Toplam Tutar</span><div className="spacer" /><strong style={{ fontSize: "1.2rem" }}>{formatCurrency(transaction.totalAmount)}</strong></div>
            <div className="toolbar"><span>Islem No</span><div className="spacer" /><strong>#{transaction.id}</strong></div>
            <div className="toolbar"><span>Tarih</span><div className="spacer" /><strong>{formatDateTime(transaction.completedAt)}</strong></div>
          </div>
        </>
      )}
      <button className="primary" style={{ marginTop: "1rem" }} onClick={onRestart}>Yeni Islem Baslat</button>
    </div>
  );
}
