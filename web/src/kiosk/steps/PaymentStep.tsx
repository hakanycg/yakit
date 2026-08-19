import { useEffect, useRef, useState, type FormEvent } from "react";
import { kioskApi } from "../kioskApi";
import { formatCurrency } from "../../shared/format";
import { ApiError } from "../../shared/api";
import { stashPendingKioskTransaction } from "../resumeStorage";
import type { Transaction } from "../../shared/types";

export default function PaymentStep({
  transaction,
  accessToken,
  iyzicoEnabled,
  onPaid,
  onCancel,
}: {
  transaction: Transaction;
  accessToken: string;
  iyzicoEnabled: boolean;
  onPaid: (t: Transaction) => void;
  onCancel: () => void;
}) {
  if (iyzicoEnabled) {
    return <IyzicoPaymentPanel transaction={transaction} accessToken={accessToken} onCancel={onCancel} />;
  }
  return <SimulatedCardPanel transaction={transaction} accessToken={accessToken} onPaid={onPaid} onCancel={onCancel} />;
}

function IyzicoPaymentPanel({
  transaction,
  accessToken,
  onCancel,
}: {
  transaction: Transaction;
  accessToken: string;
  onCancel: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutFormContent, setCheckoutFormContent] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res = await kioskApi.initIyzico(transaction.id, accessToken);
      // iyzico odeme sonucunu kiosk'un kendi origin'ine, sunucu tarafinda dogruladiktan
      // sonra tam sayfa yonlendirmeyle bildirir; SPA state'i kaybolacagi icin devam
      // etmek uzere islem kimligini ve erisim tokenini yerelde saklariz.
      stashPendingKioskTransaction(transaction.id, accessToken);
      if (res.paymentPageUrl) {
        window.location.href = res.paymentPageUrl;
        return;
      }
      setCheckoutFormContent(res.checkoutFormContent);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "iyzico odeme formu baslatilamadi.");
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (!checkoutFormContent || !containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.innerHTML = checkoutFormContent;
    Array.from(wrapper.childNodes).forEach((node) => {
      if (node.nodeName === "SCRIPT") {
        const original = node as HTMLScriptElement;
        const script = document.createElement("script");
        if (original.src) script.src = original.src;
        script.text = original.text;
        container.appendChild(script);
      } else {
        container.appendChild(node.cloneNode(true));
      }
    });
  }, [checkoutFormContent]);

  return (
    <div>
      <h2>Guvenli Odeme (iyzico)</h2>
      <p className="big-total">{formatCurrency(transaction.totalAmount)}</p>
      <p className="hint-text">Tahmini tutar; gercek tutar dolum tamamlandiginda kesinlesir.</p>
      <p className="hint-text">
        Kart bilgileriniz bu kiosk'a degil, dogrudan iyzico'nun guvenli odeme sayfasina girilir.
      </p>

      {error && <p className="error-text">{error}</p>}

      {!checkoutFormContent && (
        <div className="kiosk-actions">
          <button type="button" onClick={onCancel} disabled={starting}>Islemi Iptal Et</button>
          <button type="button" className="primary" onClick={start} disabled={starting}>
            {starting ? "Odeme formu hazirlaniyor..." : "Kart ile Ode"}
          </button>
        </div>
      )}

      <div id="iyzipay-checkout-form" className="responsive" ref={containerRef} style={{ marginTop: "1rem" }} />
    </div>
  );
}

function SimulatedCardPanel({
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
