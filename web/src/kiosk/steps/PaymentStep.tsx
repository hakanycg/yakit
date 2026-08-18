import { useState, type FormEvent } from "react";
import { kioskApi } from "../kioskApi";
import { formatCurrency } from "../../shared/format";
import { ApiError } from "../../shared/api";
import type { Transaction } from "../../shared/types";

export default function PaymentStep({
  transaction,
  accessToken,
  onPaid,
  onCancel,
}: {
  transaction: Transaction;
  accessToken: string;
  onPaid: (t: Transaction) => void;
  onCancel: () => void;
}) {
  const [cardNumber, setCardNumber] = useState("");
  const [holderName, setHolderName] = useState("");
  const [expiryMonth, setExpiryMonth] = useState("12");
  const [expiryYear, setExpiryYear] = useState(String(new Date().getFullYear() + 3));
  const [cvv, setCvv] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await kioskApi.pay(transaction.id, accessToken, {
        cardNumber,
        holderName,
        expiryMonth: Number(expiryMonth),
        expiryYear: Number(expiryYear),
        cvv,
      });
      if (res.transaction.status === "failed") {
        setError(res.transaction.cancelledReason ?? "Odeme reddedildi.");
      } else {
        onPaid(res.transaction);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Odeme sirasinda hata olustu.");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    try {
      await kioskApi.cancel(transaction.id, accessToken);
    } finally {
      onCancel();
    }
  }

  return (
    <div>
      <h2>Sanal Odeme</h2>
      <p className="big-total">{formatCurrency(transaction.totalAmount)}</p>
      <p className="hint-text">Tahmini tutar; gercek tutar dolum tamamlandiginda kesinlesir.</p>

      <form onSubmit={submit}>
        <label>Kart Uzerindeki Isim</label>
        <input value={holderName} onChange={(e) => setHolderName(e.target.value)} required />
        <label>Kart Numarasi</label>
        <input
          value={cardNumber}
          onChange={(e) => setCardNumber(e.target.value.replace(/[^\d ]/g, ""))}
          placeholder="4111 1111 1111 1111"
          maxLength={23}
          required
        />
        <div className="grid cols-3">
          <div>
            <label>Ay</label>
            <input value={expiryMonth} onChange={(e) => setExpiryMonth(e.target.value)} maxLength={2} required />
          </div>
          <div>
            <label>Yil</label>
            <input value={expiryYear} onChange={(e) => setExpiryYear(e.target.value)} maxLength={4} required />
          </div>
          <div>
            <label>CVV</label>
            <input value={cvv} onChange={(e) => setCvv(e.target.value.replace(/\D/g, ""))} maxLength={4} required />
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="kiosk-actions">
          <button type="button" onClick={cancel} disabled={submitting}>Islemi Iptal Et</button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? "Odeme isleniyor..." : "Odemeyi Onayla"}
          </button>
        </div>
      </form>
      <p className="hint-text">Bu bir sanal odeme simulasyonudur; gercek banka baglantisi kurulmaz.</p>
    </div>
  );
}
