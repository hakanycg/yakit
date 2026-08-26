import { useEffect, useRef, useState } from "react";
import { kioskApi, type FleetAccountSummary } from "../kioskApi";
import { formatCurrency } from "../../shared/format";
import { ApiError } from "../../shared/api";
import { stashPendingKioskTransaction } from "../resumeStorage";
import type { Transaction } from "../../shared/types";
import { useKioskLang } from "../i18n";
import { KioskInput } from "../KioskKeyboard";

/** Musterinin tutar secimi ekraninda gordugu fiyat ile islemin sunucuda kilitlendigi
 * gercek fiyat farkliysa (nadiren, tam o sirada fiyat degistiyse), odeme ekraninda
 * bunu acikca belirten kisa bir not dondurur; aksi halde null. */
function usePriceChangeNote(estimatedPricePerLiter: number | null, transaction: Transaction): string | null {
  const { t, locale } = useKioskLang();
  if (estimatedPricePerLiter === null) return null;
  if (Math.abs(estimatedPricePerLiter - transaction.pricePerLiter) < 0.005) return null;
  return t("payment.priceChangedNote", {
    oldPrice: formatCurrency(estimatedPricePerLiter, locale),
    newPrice: formatCurrency(transaction.pricePerLiter, locale),
  });
}

export default function PaymentStep({
  transaction,
  accessToken,
  iyzicoEnabled,
  estimatedPricePerLiter,
  onPaid,
  onCancel,
}: {
  transaction: Transaction;
  accessToken: string;
  iyzicoEnabled: boolean;
  estimatedPricePerLiter: number | null;
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
        estimatedPricePerLiter={estimatedPricePerLiter}
        onPaid={onPaid}
        onCancel={onCancel}
        onUseCard={() => setSkipFleet(true)}
      />
    );
  }

  // Kart odemesi yapilandirilmamissa islem BURADA durur. Onceden bu noktada bir
  // simulasyon paneli devreye girip odemeyi "onaylanmis" sayiyordu; gercek bir
  // istasyonda bu, parasi tahsil edilmeden yakit veren bir pompa demektir.
  if (!iyzicoEnabled) {
    return <PaymentUnavailablePanel transaction={transaction} accessToken={accessToken} onCancel={onCancel} />;
  }

  return (
    <IyzicoPaymentPanel
      transaction={transaction}
      accessToken={accessToken}
      estimatedPricePerLiter={estimatedPricePerLiter}
      onCancel={onCancel}
    />
  );
}

function PaymentUnavailablePanel({
  transaction,
  accessToken,
  onCancel,
}: {
  transaction: Transaction;
  accessToken: string;
  onCancel: () => void;
}) {
  const { t } = useKioskLang();
  async function cancel() {
    try {
      await kioskApi.cancel(transaction.id, accessToken);
    } finally {
      onCancel();
    }
  }
  return (
    <div>
      <h2>{t("payment.unavailableTitle")}</h2>
      <p className="hint-text">{t("payment.unavailableBody")}</p>
      <div className="kiosk-actions">
        <span />
        <button type="button" className="primary" onClick={cancel}>
          {t("payment.cancel")}
        </button>
      </div>
    </div>
  );
}

function FleetChoicePanel({
  account,
  transaction,
  accessToken,
  estimatedPricePerLiter,
  onPaid,
  onCancel,
  onUseCard,
}: {
  account: FleetAccountSummary;
  transaction: Transaction;
  accessToken: string;
  estimatedPricePerLiter: number | null;
  onPaid: (t: Transaction) => void;
  onCancel: () => void;
  onUseCard: () => void;
}) {
  const { t, locale } = useKioskLang();
  const priceChangeNote = usePriceChangeNote(estimatedPricePerLiter, transaction);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [odometer, setOdometer] = useState("");

  async function payWithFleet() {
    setSubmitting(true);
    setError(null);
    try {
      // Km OPSIYONEL: girilmediyse odeme normal ilerler, yalnizca o dolum tuketim
      // analizinin disinda kalir. Zorunlu olsaydi sofor uydurma bir sayi girer ve
      // butun ortalamayi bozardi.
      const km = odometer.trim() === "" ? undefined : Number(odometer);
      const res = await kioskApi.payFleet(transaction.id, accessToken, account.id, km);
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
      {priceChangeNote && <p className="hint-text" style={{ color: "var(--k-accent-2)" }}>{priceChangeNote}</p>}
      <p className="hint-text">{t("payment.estimateNote")}</p>

      <div className="kiosk-card" style={{ textAlign: "left", maxWidth: 380, margin: "1.5rem auto" }}>
        <div className="toolbar"><span>{t("payment.fleetCompany")}</span><div className="spacer" /><strong>{account.companyName}</strong></div>
        {account.availableAmount !== null && (
          <div className="toolbar"><span>{t("payment.fleetAvailable")}</span><div className="spacer" /><strong>{formatCurrency(account.availableAmount, locale)}</strong></div>
        )}
      </div>

      {/* Kilometre yalnizca FILO odemesinde sorulur: perakende musteriye sormak akisi
          bir soru uzatir ve karsiliginda hicbir sey kazandirmaz. Iki ardisik dolum
          arasindaki km ve litre, arac basina tuketim (L/100km) verir. */}
      <div className="kiosk-card" style={{ textAlign: "left", maxWidth: 380, margin: "0 auto 1.5rem" }}>
        <label htmlFor="fleet-odometer">{t("payment.odometerLabel")}</label>
        <KioskInput
          layout="numeric"
          id="fleet-odometer"
          value={odometer}
          onChange={setOdometer}
          placeholder={t("payment.odometerPlaceholder")}
          maxLength={8}
          ltr
        />
        <p className="hint-text" style={{ marginBottom: 0 }}>{t("payment.odometerHint")}</p>
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
  estimatedPricePerLiter,
  onCancel,
}: {
  transaction: Transaction;
  accessToken: string;
  estimatedPricePerLiter: number | null;
  onCancel: () => void;
}) {
  const { t, locale } = useKioskLang();
  const priceChangeNote = usePriceChangeNote(estimatedPricePerLiter, transaction);
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
        <p className="hint-text" style={{ color: "var(--k-accent-2)" }}>
          {t("payment.discountApplied", {
            discount: formatCurrency(transaction.discountAmount, locale),
            total: formatCurrency(transaction.totalAmount, locale),
          })}
        </p>
      )}
      {priceChangeNote && <p className="hint-text" style={{ color: "var(--k-accent-2)" }}>{priceChangeNote}</p>}
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
