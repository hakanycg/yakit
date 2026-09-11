import { useEffect, useState } from "react";
import type { FuelPrice, FuelType } from "../../shared/types";
import { formatCurrency } from "../../shared/format";
import { kioskApi } from "../kioskApi";
import { ApiError } from "../../shared/api";
import { useKioskLang } from "../i18n";
import { KioskInput } from "../KioskKeyboard";

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

  const [loyalty, setLoyalty] = useState<{ enabled: boolean; points: number; valueTry: number; tier: "bronze" | "silver" | "gold" | null } | null>(null);
  const [useLoyalty, setUseLoyalty] = useState(false);

  const [codeInput, setCodeInput] = useState("");
  const [appliedCode, setAppliedCode] = useState<{ code: string; discountAmount: number } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeChecking, setCodeChecking] = useState(false);

  const [campaigns, setCampaigns] = useState<{ code: string; type: "percent" | "fixed"; value: number; fuelType: FuelType | null }[]>([]);

  useEffect(() => {
    if (!plate) return;
    kioskApi
      .getLoyaltyBalance(stationId, plate)
      .then((res) => setLoyalty(res))
      .catch(() => setLoyalty(null));
  }, [stationId, plate]);

  useEffect(() => {
    kioskApi
      .getActiveCampaigns(stationId)
      .then((res) => setCampaigns(res.campaigns))
      .catch(() => setCampaigns([]));
  }, [stationId]);

  const baseTotal = mode === "amount" ? Number(amount) || 0 : mode === "liters" ? (Number(liters) || 0) * price.pricePerLiter : 0;
  const loyaltyDiscount = useLoyalty && loyalty ? loyalty.valueTry : 0;
  const codeDiscount = appliedCode?.discountAmount ?? 0;
  const estimatedCharge = Math.max(0, baseTotal - loyaltyDiscount - codeDiscount);
  const showDiscounts = mode !== "full_tank" && baseTotal > 0;

  async function applyCode(code?: string) {
    const target = (code ?? codeInput).trim();
    setCodeError(null);
    if (!target) return;
    setCodeChecking(true);
    try {
      const res = await kioskApi.previewDiscountCode(stationId, target, price.fuelType, baseTotal);
      setCodeInput(target.toUpperCase());
      setAppliedCode({ code: target.toUpperCase(), discountAmount: res.discountAmount });
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
          {/* Sistem klavyesi acilmaz; kiosk klavyesi kullanilir (bkz. KioskKeyboard.tsx). */}
          <KioskInput
            layout="numeric"
            value={amount === "" ? "" : String(amount)}
            onChange={(next) => setAmount(next === "" ? "" : Number(next))}
            maxLength={6}
            ltr
          />
        </>
      )}

      {mode === "liters" && (
        <>
          <label>{t("amount.litersLabel")}</label>
          {/* Litre ondalikli girilebilmeli; tus takimi virgul tusunu de gosterir. Deger
              Number()'a verilmeden once virgul noktaya cevrilir - Turkce klavyede
              ondalik ayirici virguldur, JavaScript ise noktayi bekler. */}
          <KioskInput
            layout="decimal"
            value={liters === "" ? "" : String(liters).replace(".", ",")}
            onChange={(next) => {
              const normalized = next.replace(",", ".");
              setLiters(normalized === "" || normalized === "." ? "" : Number(normalized));
            }}
            maxLength={6}
            ltr
          />
          {liters !== "" && <p className="hint-text">{t("amount.estimatedTotal", { amount: formatCurrency(Number(liters) * price.pricePerLiter, locale) })}</p>}
        </>
      )}

      {mode === "full_tank" && (
        <p className="hint-text">{t("amount.fullTankHint")}</p>
      )}

      {showDiscounts && (
        <div className="kiosk-card" style={{ marginTop: "1rem", padding: "0.75rem" }}>
          {loyalty?.enabled && loyalty.tier && (
            <p className="hint-text" style={{ marginTop: 0 }}>{t(`loyalty.tier.${loyalty.tier}`)}</p>
          )}
          {loyalty?.enabled && loyalty.points > 0 && (
            <label className="check" style={{ marginBottom: "0.5rem" }}>
              <input type="checkbox" checked={useLoyalty} onChange={(e) => setUseLoyalty(e.target.checked)} />
              {t("amount.useLoyalty", { points: loyalty.points, value: formatCurrency(loyalty.valueTry, locale) })}
            </label>
          )}

          {campaigns.filter((c) => !c.fuelType || c.fuelType === price.fuelType).length > 0 && (
            <div style={{ marginBottom: "0.75rem" }}>
              <label>{t("amount.activeCampaignsTitle")}</label>
              <div className="option-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
                {campaigns
                  .filter((c) => !c.fuelType || c.fuelType === price.fuelType)
                  .map((c) => (
                    <button
                      key={c.code}
                      type="button"
                      className={`option-btn ${appliedCode?.code === c.code ? "selected" : ""}`}
                      disabled={codeChecking}
                      onClick={() => applyCode(c.code)}
                    >
                      <strong>{c.code}</strong>
                      <br />
                      {c.type === "percent"
                        ? t("amount.campaignPercentOff", { value: c.value })
                        : t("amount.campaignFixedOff", { value: formatCurrency(c.value, locale) })}
                      {c.fuelType && (
                        <>
                          <br />
                          <small>{t("amount.campaignFuelRestricted", { fuel: t(`fuel.${c.fuelType}`) })}</small>
                        </>
                      )}
                    </button>
                  ))}
              </div>
            </div>
          )}

          <label>{t("amount.discountCodeLabel")}</label>
          <div className="toolbar" style={{ margin: 0 }}>
            <KioskInput
              layout="code"
              value={codeInput}
              onChange={(next) => {
                setCodeInput(next.toUpperCase());
                setAppliedCode(null);
                setCodeError(null);
              }}
              placeholder={t("amount.discountCodePlaceholder")}
              maxLength={24}
              ltr
            />
            <button type="button" disabled={codeChecking || !codeInput.trim()} onClick={() => applyCode()}>
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
