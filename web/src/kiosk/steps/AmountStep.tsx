import { useEffect, useState } from "react";
import type { FuelPrice } from "../../shared/types";
import { formatCurrency } from "../../shared/format";
import { kioskApi } from "../kioskApi";
import { ApiError } from "../../shared/api";
import { useKioskLang } from "../i18n";

export type AmountSelection =
  | { mode: "amount"; amount: number; discountCode?: string; redeemPoints?: number }
  | { mode: "liters"; liters: number; discountCode?: string; redeemPoints?: number }
  | { mode: "full_tank" };

const QUICK_AMOUNTS = [200, 500, 1000, 2000];

export default function AmountStep({
  price,
  stationId,
  plate,
  onNext,
  onBack,
}: {
  price: FuelPrice;
  stationId: number;
  plate: string;
  onNext: (selection: AmountSelection) => void;
  onBack: () => void;
}) {
  const { t, locale } = useKioskLang();
  const [mode, setMode] = useState<"amount" | "liters" | "full_tank">("amount");
  const [amount, setAmount] = useState<number | "">("");
  const [liters, setLiters] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);

  const [loyalty, setLoyalty] = useState<{ enabled: boolean; points: number; valueTry: number } | null>(null);
  const [useLoyalty, setUseLoyalty] = useState(false);

  const [codeInput, setCodeInput] = useState("");
  const [appliedCode, setAppliedCode] = useState<{ code: string; discountAmount: number } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeChecking, setCodeChecking] = useState(false);

  useEffect(() => {
    if (!plate) return;
    kioskApi
      .getLoyaltyBalance(stationId, plate)
      .then((res) => setLoyalty(res))
      .catch(() => setLoyalty(null));
  }, [stationId, plate]);

  const baseTotal = mode === "amount" ? Number(amount) || 0 : mode === "liters" ? (Number(liters) || 0) * price.pricePerLiter : 0;
  const loyaltyDiscount = useLoyalty && loyalty ? loyalty.valueTry : 0;
  const codeDiscount = appliedCode?.discountAmount ?? 0;
  const estimatedCharge = Math.max(0, baseTotal - loyaltyDiscount - codeDiscount);
  const showDiscounts = mode !== "full_tank" && baseTotal > 0;

  async function applyCode() {
    setCodeError(null);
    if (!codeInput.trim()) return;
    setCodeChecking(true);
    try {
      const res = await kioskApi.previewDiscountCode(stationId, codeInput.trim(), price.fuelType, baseTotal);
      setAppliedCode({ code: codeInput.trim().toUpperCase(), discountAmount: res.discountAmount });
    } catch (err) {
      setAppliedCode(null);
      setCodeError(err instanceof ApiError ? err.message : t("error.codeInvalid"));
    } finally {
      setCodeChecking(false);
    }
  }

  function submit() {
    setError(null);
    if (mode === "amount") {
      if (!amount || amount <= 0) return setError(t("amount.invalidAmount"));
      onNext({
        mode: "amount",
        amount,
        discountCode: appliedCode?.code,
        redeemPoints: useLoyalty && loyalty ? loyalty.points : undefined,
      });
    } else if (mode === "liters") {
      if (!liters || liters <= 0) return setError(t("amount.invalidLiters"));
      onNext({
        mode: "liters",
        liters,
        discountCode: appliedCode?.code,
        redeemPoints: useLoyalty && loyalty ? loyalty.points : undefined,
      });
    } else {
      onNext({ mode: "full_tank" });
    }
  }

  return (
    <div>
      <h2>{t("amount.title")}</h2>
      <div className="option-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <button className={`option-btn ${mode === "amount" ? "selected" : ""}`} onClick={() => setMode("amount")}>{t("amount.modeAmount")}</button>
        <button className={`option-btn ${mode === "liters" ? "selected" : ""}`} onClick={() => setMode("liters")}>{t("amount.modeLiters")}</button>
        <button className={`option-btn ${mode === "full_tank" ? "selected" : ""}`} onClick={() => setMode("full_tank")}>{t("amount.modeFullTank")}</button>
      </div>

      {mode === "amount" && (
        <>
          <div className="option-grid">
            {QUICK_AMOUNTS.map((q) => (
              <button key={q} className={`option-btn ${amount === q ? "selected" : ""}`} onClick={() => setAmount(q)}>
                {formatCurrency(q, locale)}
              </button>
            ))}
          </div>
          <label>{t("amount.customAmountLabel")}</label>
          <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value ? Number(e.target.value) : "")} />
        </>
      )}

      {mode === "liters" && (
        <>
          <label>{t("amount.litersLabel")}</label>
          <input type="number" min={0.1} step={0.1} value={liters} onChange={(e) => setLiters(e.target.value ? Number(e.target.value) : "")} />
          {liters !== "" && <p className="hint-text">{t("amount.estimatedTotal", { amount: formatCurrency(Number(liters) * price.pricePerLiter, locale) })}</p>}
        </>
      )}

      {mode === "full_tank" && (
        <p className="hint-text">{t("amount.fullTankHint")}</p>
      )}

      {showDiscounts && (
        <div className="kiosk-card" style={{ marginTop: "1rem", padding: "0.75rem" }}>
          {loyalty?.enabled && loyalty.points > 0 && (
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
              <input type="checkbox" checked={useLoyalty} onChange={(e) => setUseLoyalty(e.target.checked)} />
              {t("amount.useLoyalty", { points: loyalty.points, value: formatCurrency(loyalty.valueTry, locale) })}
            </label>
          )}

          <label>{t("amount.discountCodeLabel")}</label>
          <div className="toolbar" style={{ margin: 0 }}>
            <input
              value={codeInput}
              onChange={(e) => {
                setCodeInput(e.target.value);
                setAppliedCode(null);
                setCodeError(null);
              }}
              placeholder={t("amount.discountCodePlaceholder")}
              style={{ textTransform: "uppercase" }}
            />
            <button type="button" disabled={codeChecking || !codeInput.trim()} onClick={applyCode}>
              {codeChecking ? t("amount.checkingCode") : t("amount.applyCode")}
            </button>
          </div>
          {codeError && <p className="error-text">{codeError}</p>}
          {appliedCode && (
            <p className="hint-text" style={{ color: "var(--k-accent-2)" }}>
              {t("amount.codeApplied", { code: appliedCode.code, amount: formatCurrency(appliedCode.discountAmount, locale) })}
            </p>
          )}

          {(loyaltyDiscount > 0 || codeDiscount > 0) && (
            <p style={{ marginTop: "0.5rem", marginBottom: 0 }}>
              <strong>{t("amount.estimatedCharge", { amount: formatCurrency(estimatedCharge, locale) })}</strong>
            </p>
          )}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="kiosk-actions">
        <button onClick={onBack}>{t("action.back")}</button>
        <button className="primary" onClick={submit}>{t("action.continue")}</button>
      </div>
    </div>
  );
}
