import { useState } from "react";
import { FUEL_LABEL, formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import { kioskApi } from "../kioskApi";
import { ApiError } from "../../shared/api";
import type { Transaction } from "../../shared/types";

export default function ReceiptStep({
  transaction,
  accessToken,
  onRestart,
}: {
  transaction: Transaction;
  accessToken: string | null;
  onRestart: () => void;
}) {
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

          {accessToken && <ReceiptSender transactionId={transaction.id} accessToken={accessToken} />}
        </>
      )}
      <button className="primary" style={{ marginTop: "1rem" }} onClick={onRestart}>Yeni Islem Baslat</button>
    </div>
  );
}

function ReceiptSender({ transactionId, accessToken }: { transactionId: number; accessToken: string }) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSending(true);
    setError(null);
    setMessage(null);
    try {
      const { result } = await kioskApi.sendReceipt(transactionId, accessToken, {
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      const parts: string[] = [];
      if (result.email) parts.push(result.email.sent ? "E-posta gonderildi." : `E-posta gonderilemedi: ${result.email.reason ?? ""}`);
      if (result.sms) parts.push(result.sms.sent ? "SMS gonderildi." : `SMS gonderilemedi: ${result.sms.reason ?? ""}`);
      setMessage(parts.join(" ") || "Makbuz gonderildi.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Makbuz gonderilemedi.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card" style={{ textAlign: "left", maxWidth: 380, margin: "0 auto 1rem" }}>
      <h4 style={{ marginTop: 0 }}>Makbuzu Gonder</h4>
      <label>E-posta (opsiyonel)</label>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ornek@eposta.com" />
      <label>Telefon (opsiyonel)</label>
      <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="05xx xxx xx xx" />
      {error && <p className="error-text">{error}</p>}
      {message && <p className="hint-text" style={{ color: "#4ade80" }}>{message}</p>}
      <button style={{ marginTop: "0.75rem" }} disabled={sending || (!email.trim() && !phone.trim())} onClick={submit}>
        {sending ? "Gonderiliyor..." : "Gonder"}
      </button>
    </div>
  );
}
