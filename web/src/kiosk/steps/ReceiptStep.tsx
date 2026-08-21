import { useEffect, useRef, useState } from "react";
import { formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import { kioskApi } from "../kioskApi";
import { ApiError } from "../../shared/api";
import type { Transaction } from "../../shared/types";
import { useKioskLang } from "../i18n";

export default function ReceiptStep({
  transaction,
  accessToken,
  onRestart,
}: {
  transaction: Transaction;
  accessToken: string | null;
  onRestart: () => void;
}) {
  const { t, locale } = useKioskLang();
  const failed = transaction.status === "failed" || transaction.status === "cancelled";
  // "completed" durumundaki bir islemin cancelledReason'i dolduysa, dagitilan miktar
  // hedeflenenden az kalmis demektir - ama bunun sebebi FARKLI olabilir: depo gercekten
  // tukendi (musteriye bildirilmesi gereken, beklenen bir durum) veya operator/sunucu
  // islemi durdurdu (ör. Acil Durdur, restart sonrasi kurtarma) - bu ikincisi musteri
  // acisindan "depo doldu" degildir, yanlis izlenim verir. Sunucunun bu iki tam olarak
  // ayni metni urettigi TEK yer startDispensing()'teki ranDry dalidir (bkz.
  // transactionService.ts); digger tum "completed + cancelledReason" durumlari
  // (operator durdurmasi, pompa sifirlama, ariza, sunucu restart kurtarmasi) buraya
  // dahil degildir ve genel bir "kismi dolum" notuyla gosterilir.
  const isTankDepletionNote = transaction.cancelledReason === "Depo dolum sirasinda tukendi; islem eldeki miktarla sonuclandirildi.";

  // Fiziksel fis yazicisi (kiosk PC'sinde varsayilan yazici olarak ayarlanmis, Chromium
  // "--kiosk-printing" bayragiyla acilmis bir termal yazici) tarayicinin kendi yazdirma
  // ozelligiyle (window.print) tetiklenir - ayri bir donanim kutuphanesine gerek yok.
  // Basarili bir dolumda fis otomatik olarak bir kez yazdirilir; her ihtimale karsi
  // (kagit sikismasi, musterinin ikinci nusha istemesi) manuel "Yazdir" butonu da kalir.
  const printedRef = useRef<number | null>(null);
  useEffect(() => {
    if (failed) return;
    if (printedRef.current === transaction.id) return;
    printedRef.current = transaction.id;
    window.print();
  }, [failed, transaction.id]);

  return (
    <div style={{ textAlign: "center" }}>
      <h2>{failed ? t("receipt.failedTitle") : t("receipt.completedTitle")}</h2>
      {failed ? (
        <p className="error-text">{transaction.cancelledReason ?? t("receipt.cancelledDefault")}</p>
      ) : (
        <>
          <p className="hint-text">{t("receipt.successNote")}</p>
          {transaction.cancelledReason && (
            <p className="error-text">
              {isTankDepletionNote
                ? t("receipt.tankFullNote", { liters: formatLiters(transaction.dispensedLiters) })
                : t("receipt.partialFillNote", { liters: formatLiters(transaction.dispensedLiters) })}
            </p>
          )}
          <div className="card kiosk-receipt-print" style={{ textAlign: "left", maxWidth: 380, margin: "1.5rem auto" }}>
            <h3 style={{ marginTop: 0, textAlign: "center" }}>{t("receipt.printTitle")}</h3>
            <div className="toolbar"><span>{t("receipt.plate")}</span><div className="spacer" /><strong dir="ltr">{transaction.plate}</strong></div>
            <div className="toolbar"><span>{t("receipt.fuel")}</span><div className="spacer" /><strong>{t(`fuel.${transaction.fuelType}`)}</strong></div>
            <div className="toolbar"><span>{t("receipt.amount")}</span><div className="spacer" /><strong>{formatLiters(transaction.dispensedLiters)}</strong></div>
            <div className="toolbar"><span>{t("receipt.pricePerLiter")}</span><div className="spacer" /><strong>{formatCurrency(transaction.pricePerLiter, locale)}</strong></div>
            {transaction.discountAmount > 0 ? (
              <>
                <div className="toolbar"><span>{t("receipt.fuelValue")}</span><div className="spacer" /><strong>{formatCurrency(transaction.totalAmount, locale)}</strong></div>
                <div className="toolbar"><span>{t("receipt.discount")}</span><div className="spacer" /><strong>-{formatCurrency(transaction.discountAmount, locale)}</strong></div>
                <div className="toolbar"><span>{t("receipt.chargedAmount")}</span><div className="spacer" /><strong style={{ fontSize: "1.2rem" }}>{formatCurrency(transaction.chargeAmount, locale)}</strong></div>
              </>
            ) : (
              <div className="toolbar"><span>{t("receipt.totalAmount")}</span><div className="spacer" /><strong style={{ fontSize: "1.2rem" }}>{formatCurrency(transaction.totalAmount, locale)}</strong></div>
            )}
            {transaction.loyaltyPointsEarned > 0 && (
              <div className="toolbar"><span>{t("receipt.pointsEarned")}</span><div className="spacer" /><strong>{transaction.loyaltyPointsEarned}</strong></div>
            )}
            <div className="toolbar"><span>{t("receipt.transactionNo")}</span><div className="spacer" /><strong>#{transaction.id}</strong></div>
            <div className="toolbar"><span>{t("receipt.date")}</span><div className="spacer" /><strong>{formatDateTime(transaction.completedAt, locale)}</strong></div>
          </div>

          <button style={{ marginTop: "0.5rem" }} onClick={() => window.print()}>{t("receipt.print")}</button>

          {accessToken && <ReceiptSender transactionId={transaction.id} accessToken={accessToken} />}
        </>
      )}
      <button className="primary" style={{ marginTop: "1rem" }} onClick={onRestart}>{t("receipt.restart")}</button>
    </div>
  );
}

function ReceiptSender({ transactionId, accessToken }: { transactionId: number; accessToken: string }) {
  const { t } = useKioskLang();
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
      if (result.email) parts.push(result.email.sent ? t("receipt.emailSent") : t("receipt.emailFailed", { reason: result.email.reason ?? "" }));
      if (result.sms) parts.push(result.sms.sent ? t("receipt.smsSent") : t("receipt.smsFailed", { reason: result.sms.reason ?? "" }));
      setMessage(parts.join(" ") || t("receipt.sentGeneric"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("error.receiptSendFailed"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card" style={{ textAlign: "left", maxWidth: 380, margin: "0 auto 1rem" }}>
      <h4 style={{ marginTop: 0 }}>{t("receipt.sendReceiptTitle")}</h4>
      <label>{t("receipt.emailLabel")}</label>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("receipt.emailPlaceholder")} />
      <label>{t("receipt.phoneLabel")}</label>
      <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t("receipt.phonePlaceholder")} />
      {error && <p className="error-text">{error}</p>}
      {message && <p className="hint-text" style={{ color: "#4ade80" }}>{message}</p>}
      <button style={{ marginTop: "0.75rem" }} disabled={sending || (!email.trim() && !phone.trim())} onClick={submit}>
        {sending ? t("receipt.sending") : t("receipt.send")}
      </button>
    </div>
  );
}
