import { useEffect, useRef, useState } from "react";
import { formatCurrency, formatLiters } from "../../shared/format";
import type { Transaction } from "../../shared/types";
import { ltrIsolate, useKioskLang } from "../i18n";

export default function DispenseStep({ transaction, targetLiters }: { transaction: Transaction; targetLiters: number }) {
  const { t, locale } = useKioskLang();
  const percent = targetLiters > 0 ? Math.min(100, (transaction.dispensedLiters / targetLiters) * 100) : 0;
  const waiting = transaction.status === "authorized";

  // Kalan sure tahmini: gercek bir donanim sinyali yok, WS/REST ile gelen dispensedLiters
  // orneklerinden aninlik akis hizini (L/sn) tureyip ustel yumusatma uyguluyoruz - tek bir
  // orneklem araligina gore hesaplamak (ornegin son iki paket arasi) kucuk agdaki gecikme
  // dalgalanmalarinda kalan sureyi ziplatirdi.
  const sampleRef = useRef<{ time: number; liters: number } | null>(null);
  const rateRef = useRef<number | null>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (waiting || targetLiters <= 0) {
      sampleRef.current = null;
      rateRef.current = null;
      setEtaSeconds(null);
      return;
    }
    const now = Date.now();
    const prev = sampleRef.current;
    if (prev) {
      const dt = (now - prev.time) / 1000;
      const dl = transaction.dispensedLiters - prev.liters;
      if (dt > 0.2 && dl >= 0) {
        const instantRate = dl / dt;
        rateRef.current = rateRef.current === null ? instantRate : rateRef.current * 0.6 + instantRate * 0.4;
      }
    }
    sampleRef.current = { time: now, liters: transaction.dispensedLiters };

    const remainingLiters = Math.max(0, targetLiters - transaction.dispensedLiters);
    if (rateRef.current && rateRef.current > 0.01) {
      setEtaSeconds(Math.round(remainingLiters / rateRef.current));
    }
  }, [transaction.dispensedLiters, waiting, targetLiters]);

  // Yeni bir veri paketi her birkac saniyede bir geldigi icin, aradaki sureyi saniyede bir
  // geri sayarak dolduruyoruz - aksi halde gosterge WS/REST paketleri arasinda donuk kalirdi.
  useEffect(() => {
    if (waiting) return;
    const interval = setInterval(() => {
      setEtaSeconds((prev) => (prev !== null && prev > 0 ? prev - 1 : prev));
    }, 1000);
    return () => clearInterval(interval);
  }, [waiting]);

  return (
    <div>
      <h2>{waiting ? t("dispense.authorizing") : t("dispense.inProgress")}</h2>
      <p className="hint-text">{t("dispense.plateAndPump", { plate: ltrIsolate(transaction.plate), pump: transaction.pumpId })}</p>

      <div className="progress-bar" style={{ margin: "1.5rem 0" }}>
        <div className="fill" style={{ width: `${waiting ? 0 : percent}%` }} />
      </div>

      <div className="grid cols-2">
        <div className="stat">
          <span className="label">{t("dispense.amountLabel")}</span>
          <span className="value">{formatLiters(transaction.dispensedLiters)}</span>
        </div>
        <div className="stat">
          <span className="label">{t("dispense.currentTotalLabel")}</span>
          <span className="value">{formatCurrency(transaction.totalAmount, locale)}</span>
        </div>
      </div>

      {!waiting && targetLiters > 0 && percent < 100 && (
        <div className="stat" style={{ marginTop: "1rem" }}>
          <span className="label">{t("dispense.etaLabel")}</span>
          <span className="value">{formatEta(etaSeconds, t)}</span>
        </div>
      )}

      <p className="hint-text" style={{ marginTop: "1.5rem" }}>
        {t("dispense.waitNote", { status: t(`transactionStatus.${transaction.status}`) })}
      </p>
    </div>
  );
}

function formatEta(seconds: number | null, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (seconds === null) return t("dispense.etaCalculating");
  if (seconds < 60) return t("dispense.etaSeconds", { seconds });
  return t("dispense.etaMinutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}
