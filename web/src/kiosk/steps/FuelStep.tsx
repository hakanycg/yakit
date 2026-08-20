import type { FuelPrice, FuelType, Pump } from "../../shared/types";
import { formatCurrency } from "../../shared/format";
import { useKioskLang } from "../i18n";

export default function FuelStep({
  pump,
  fuelPrices,
  onNext,
  onBack,
}: {
  pump: Pump;
  fuelPrices: FuelPrice[];
  onNext: (fuelType: FuelType) => void;
  onBack: () => void;
}) {
  const { t, locale } = useKioskLang();
  const available = fuelPrices.filter((f) => pump.fuelTypes.includes(f.fuelType));

  return (
    <div>
      <h2>{t("fuelStep.title")}</h2>
      <p className="hint-text">{t("fuelStep.subtitle", { pump: pump.label })}</p>
      <div className="option-grid">
        {available.map((f) => {
          const outOfStock = f.inStock === false;
          return (
            <button
              key={f.fuelType}
              className="option-btn"
              disabled={outOfStock}
              onClick={() => onNext(f.fuelType)}
              title={outOfStock ? t("fuelStep.outOfStockTitle") : undefined}
            >
              <strong>{t(`fuel.${f.fuelType}`)}</strong>
              <br />
              {outOfStock ? (
                <span className="error-text">{t("fuelStep.outOfStock")}</span>
              ) : (
                <span className="hint-text">{t("fuelStep.perLiter", { price: formatCurrency(f.pricePerLiter, locale) })}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="kiosk-actions">
        <button onClick={onBack}>{t("action.back")}</button>
        <span />
      </div>
    </div>
  );
}
