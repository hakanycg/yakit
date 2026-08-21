import { useEffect, useRef, useState, type FormEvent } from "react";
import { kioskApi, type FleetAccountSummary } from "../kioskApi";
import { formatCurrency } from "../../shared/format";
import { ApiError } from "../../shared/api";
import { stashPendingKioskTransaction } from "../resumeStorage";
import type { Transaction } from "../../shared/types";
import { useKioskLang } from "../i18n";

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
  const { t } = useKioskLang();
  const [fleetAccount, setFleetAccount] = useState<FleetAccountSummary | null>(null);
  const [fleetChecked, setFleetChecked] = useState(false);
  const [skipFleet, setSkipFleet] = useState(false);

  useEffect(() => {
    // Filo hesabi ile odeme, tutari basindan kesin bilinmeyen "Depoyu Doldur" modunda
    // sunulmaz - bkz. payWithFleetAccount yorumu (iyzico on-provizyon ile ayni sinirlama).
    if (transaction.amountMode === "full_tank") {
      setFleetChecked(true);
      return;
    }
    kioskApi
      .getFleetAccount(transaction.stationId, transaction.plate)
      .then((res) => setFleetAccount(res.account))
      .catch(() => setFleetAccount(null))
      .finally(() => setFleetChecked(true));
  }, [transaction.stationId, transaction.plate, transaction.amountMode]);

  if (!fleetChecked) return <p className="hint-text">{t("loading")}</p>;

  const canUseFleet =
    !skipFleet &&
    !!fleetAccount &&
    fleetAccount.active &&
    (fleetAccount.availableAmount === null || fleetAccount.availableAmount >= transaction.chargeAmount);

  if (canUseFleet && fleetAccount) {
    return (
      <FleetChoicePanel
        account={fleetAccount}
        transaction={transaction}
        accessToken={accessToken}
        onPaid={onPaid}
        onCancel={onCancel}
        onUseCard={() => setSkipFleet(true)}
      />
    );
  }

  if (iyzicoEnabled) {
    return <IyzicoPaymentPanel transaction={transaction} accessToken={accessToken} onCancel={onCancel} />;
  }
  return <SimulatedCardPanel transaction={transaction} accessToken={accessToken} onPaid={onPaid} onCancel={onCancel} />;
}

function FleetChoicePanel({
  account,
  transaction,
  accessToken,
  onPaid,
  onCancel,
  onUseCard,
}: {
  account: FleetAccountSummary;
  transaction: Transaction;
  accessToken: string;
  onPaid: (t: Transaction) => void;
  onCancel: () => void;
  onUseCard: () => void;
}) {
  const { t, locale } = useKioskLang();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function payWithFleet() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await kioskApi.payFleet(transaction.id, accessToken, account.id);
      onPaid(res.transaction);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("error.paymentFailed"));
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
      <h2>{t("payment.fleetTitle")}</h2>
      <p className="big-total">{formatCurrency(transaction.chargeAmount, locale)}</p>
      <p className="hint-text">{t("payment.estimateNote")}</p>

      <div className="card" style={{ textAlign: "left", maxWidth: 380, margin: "1.5rem auto" }}>
        <div className="toolbar"><span>{t("payment.fleetCompany")}</span><div className="spacer" /><strong>{account.companyName}</strong></div>
        {account.availableAmount !== null && (
          <div className="toolbar"><span>{t("payment.fleetAvailable")}</span><div className="spacer" /><strong>{formatCurrency(account.availableAmount, locale)}</strong></div>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="kiosk-actions">
        <button type="button" onClick={cancel} disabled={submitting}>{t("payment.cancel")}</button>
        <button type="button" onClick={onUseCard} disabled={submitting}>{t("payment.fleetUseCardInstead")}</button>
        <button type="button" className="primary" onClick={payWithFleet} disabled={submitting}>
          {submitting ? t("payment.processing") : t("payment.fleetPayButton")}
        </button>
      </div>
    </div>
  );
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
  const { t, locale } = useKioskLang();
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
      setError(err instanceof ApiError ? err.message : t("error.iyzicoStartFailed"));
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
      <h2>{t("payment.iyzicoTitle")}</h2>
      <p className="big-total">{formatCurrency(transaction.chargeAmount, locale)}</p>
      {transaction.discountAmount > 0 && (
        <p className="hint-text" style={{ color: "var(--accent-2)" }}>
          {t("payment.discountApplied", {
            discount: formatCurrency(transaction.discountAmount, locale),
            total: formatCurrency(transaction.totalAmount, locale),
          })}
        </p>
      )}
      <p className="hint-text">{t("payment.estimateNote")}</p>
      <p className="hint-text">{t("payment.iyzicoSecureNote")}</p>

      {error && <p className="error-text">{error}</p>}

      {!checkoutFormContent && (
        <div className="kiosk-actions">
          <button type="button" onClick={onCancel} disabled={starting}>{t("payment.cancel")}</button>
          <button type="button" className="primary" onClick={start} disabled={starting}>
            {starting ? t("payment.preparingForm") : t("payment.payWithCard")}
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
  const { t, locale } = useKioskLang();
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
        setError(res.transaction.cancelledReason ?? t("error.paymentRejected"));
      } else {
        onPaid(res.transaction);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("error.paymentFailed"));
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
      <h2>{t("payment.simulatedTitle")}</h2>
      <p className="big-total">{formatCurrency(transaction.chargeAmount, locale)}</p>
      {transaction.discountAmount > 0 && (
        <p className="hint-text" style={{ color: "var(--accent-2)" }}>
          {t("payment.discountApplied", {
            discount: formatCurrency(transaction.discountAmount, locale),
            total: formatCurrency(transaction.totalAmount, locale),
          })}
        </p>
      )}
      <p className="hint-text">{t("payment.estimateNote")}</p>

      <form onSubmit={submit}>
        <label>{t("payment.cardHolderLabel")}</label>
        <input value={holderName} onChange={(e) => setHolderName(e.target.value)} required />
        <label>{t("payment.cardNumberLabel")}</label>
        <input
          value={cardNumber}
          onChange={(e) => setCardNumber(e.target.value.replace(/[^\d ]/g, ""))}
          placeholder="4111 1111 1111 1111"
          maxLength={23}
          required
        />
        <div className="grid cols-3">
          <div>
            <label>{t("payment.monthLabel")}</label>
            <input value={expiryMonth} onChange={(e) => setExpiryMonth(e.target.value)} maxLength={2} required />
          </div>
          <div>
            <label>{t("payment.yearLabel")}</label>
            <input value={expiryYear} onChange={(e) => setExpiryYear(e.target.value)} maxLength={4} required />
          </div>
          <div>
            <label>{t("payment.cvvLabel")}</label>
            <input value={cvv} onChange={(e) => setCvv(e.target.value.replace(/\D/g, ""))} maxLength={4} required />
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="kiosk-actions">
          <button type="button" onClick={cancel} disabled={submitting}>{t("payment.cancel")}</button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? t("payment.processing") : t("payment.confirm")}
          </button>
        </div>
      </form>
      <p className="hint-text">{t("payment.simulationNote")}</p>
    </div>
  );
}
