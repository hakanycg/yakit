import { formatCurrency, formatLiters } from "../../shared/format";
import type { Transaction } from "../../shared/types";
import { ltrIsolate, useKioskLang } from "../i18n";

export default function DispenseStep({ transaction, targetLiters }: { transaction: Transaction; targetLiters: number }) {
  const { t, locale } = useKioskLang();
  const percent = targetLiters > 0 ? Math.min(100, (transaction.dispensedLiters / targetLiters) * 100) : 0;
  const waiting = transaction.status === "authorized";

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

      <p className="hint-text" style={{ marginTop: "1.5rem" }}>
        {t("dispense.waitNote", { status: t(`transactionStatus.${transaction.status}`) })}
      </p>
    </div>
  );
}
