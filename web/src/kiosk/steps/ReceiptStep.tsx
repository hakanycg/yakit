import { useEffect, useRef, useState } from "react";
import { formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import { kioskApi } from "../kioskApi";
import { ApiError } from "../../shared/api";
import type { Transaction } from "../../shared/types";
import { useKioskLang } from "../i18n";
import { tryPrintFiscalReceiptViaAgent, tryPrintViaAgent, type ReceiptLine } from "../localAgentPrint";

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

  // Fisi ONCE ayni kiosk PC'sindeki istasyon ajaninin gercek termal yazicisina
  // (varsa) yazdirmayi dener (bkz. agent/src/printerDriver.ts); henuz hicbir
  // istasyonda gercek yazici baglanmadigindan bu her zaman basarisiz doner ve
  // tarayicinin kendi yazdirma ozelligine (window.print - kiosk PC'sinde varsayilan
  // yazici olarak ayarlanmis, Chromium "--kiosk-printing" bayragiyla acilmis bir
  // termal yazici varsayimiyla) duser - yani bugunku davranista degisiklik yok,
  // gercek yazici baglaninca otomatik olarak devreye girer. Basarili bir dolumda
  // fis otomatik olarak bir kez yazdirilir; her ihtimale karsi (kagit sikismasi,
  // musterinin ikinci nusha istemesi) manuel "Yazdir" butonu da kalir.
  function buildReceiptLines(): ReceiptLine[] {
    const lines: ReceiptLine[] = [
      { label: t("receipt.plate"), value: transaction.plate },
      { label: t("receipt.fuel"), value: t(`fuel.${transaction.fuelType}`) },
      { label: t("receipt.amount"), value: formatLiters(transaction.dispensedLiters) },
      { label: t("receipt.pricePerLiter"), value: formatCurrency(transaction.pricePerLiter, locale) },
    ];
    if (transaction.discountAmount > 0) {
      lines.push(
        { label: t("receipt.fuelValue"), value: formatCurrency(transaction.totalAmount, locale) },
        { label: t("receipt.discount"), value: `-${formatCurrency(transaction.discountAmount, locale)}` },
        { label: t("receipt.chargedAmount"), value: formatCurrency(transaction.chargeAmount, locale) }
      );
    } else {
      lines.push({ label: t("receipt.totalAmount"), value: formatCurrency(transaction.totalAmount, locale) });
    }
    if (transaction.loyaltyPointsEarned > 0) {
      lines.push({ label: t("receipt.pointsEarned"), value: String(transaction.loyaltyPointsEarned) });
    }
    lines.push(
      { label: t("receipt.transactionNo"), value: `#${transaction.id}` },
      { label: t("receipt.date"), value: formatDateTime(transaction.completedAt, locale) }
    );
    return lines;
  }

  const [printerFault, setPrinterFault] = useState(false);

  async function printReceipt() {
    const result = await tryPrintViaAgent({
      title: t("receipt.printTitle"),
      lines: buildReceiptLines(),
      transactionId: transaction.id,
    });
    setPrinterFault(!!result.faultCode);
    if (!result.printed) window.print();
  }

  // Yasal fisi (ÖKC) SADECE bir kez, otomatik olarak dener - manuel "Yazdir" butonuyla
  // alinan ek nushalar (kagit sikismasi/musteri ikinci nusha isterse) tekrar
  // fiskallestirilmemelidir, o yuzden printReceipt()'ten AYRI ve yalnizca ilk otomatik
  // yazdirmada cagrilir (bkz. asagidaki useEffect). Henuz gercek bir ÖKC baglanmadigindan
  // (bkz. localAgentPrint.ts) bunun bugunku davranista GOZLEMLENEBILIR hicbir etkisi yoktur.
  async function printFiscalReceipt() {
    await tryPrintFiscalReceiptViaAgent({
      title: t("receipt.printTitle"),
      lines: buildReceiptLines(),
      transactionId: transaction.id,
      amount: transaction.chargeAmount,
    });
  }

  const printedRef = useRef<number | null>(null);
  useEffect(() => {
    if (failed) return;
    if (printedRef.current === transaction.id) return;
    printedRef.current = transaction.id;
    printFiscalReceipt();
    printReceipt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          <div className="kiosk-card kiosk-receipt-print" style={{ textAlign: "left", maxWidth: 380, margin: "1.5rem auto" }}>
            <h3 style={{ textAlign: "center" }}>{t("receipt.printTitle")}</h3>
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

          <button style={{ marginTop: "0.5rem" }} onClick={printReceipt}>{t("receipt.print")}</button>
          {printerFault && <p className="error-text">{t("receipt.printerFaultNote")}</p>}

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
    <div className="kiosk-card" style={{ textAlign: "left", maxWidth: 380, margin: "0 auto 1rem" }}>
      <h4>{t("receipt.sendReceiptTitle")}</h4>
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
