import { useEffect, useState } from "react";
import type { FuelPrice, FuelType, Pump } from "../../shared/types";
import { formatCurrency } from "../../shared/format";
import { kioskApi } from "../kioskApi";
import { useKioskLang } from "../i18n";

export default function FuelStep({
  pump,
  fuelPrices,
  stationId,
  plate,
  onNext,
  onBack,
}: {
  pump: Pump;
  fuelPrices: FuelPrice[];
  stationId: number;
  plate: string;
  onNext: (fuelType: FuelType) => void;
  onBack: () => void;
}) {
  const { t, locale } = useKioskLang();
  const available = fuelPrices.filter((f) => pump.fuelTypes.includes(f.fuelType));

  // Yanlis yakit onleme: resmi bir ruhsat/tescil kaydimiz olmadigi icin, bu plakanin bu
  // istasyonda EN SON basariyla hangi yakitla dolum yaptigini kendi gecmisimizden
  // ogreniyoruz. Aracin motor tipi pratikte degismedigi icin farkli bir tur secilmesi,
  // kesin bir hata kaniti degil ama guclu bir sinyaldir - bu yuzden engellemek yerine
  // musteriye onay sorulur.
  const [lastFuelType, setLastFuelType] = useState<FuelType | null>(null);
  const [pendingFuelType, setPendingFuelType] = useState<FuelType | null>(null);

  useEffect(() => {
    if (!plate) return;
    kioskApi
      .getLastFuelType(stationId, plate)
      .then((res) => setLastFuelType(res.fuelType))
      .catch(() => setLastFuelType(null));
  }, [stationId, plate]);

  function selectFuel(fuelType: FuelType) {
    if (lastFuelType && lastFuelType !== fuelType) {
      setPendingFuelType(fuelType);
      return;
    }
    onNext(fuelType);
  }

  if (pendingFuelType) {
    return (
      <div style={{ textAlign: "center" }}>
        <h2>{t("fuelStep.mismatchTitle")}</h2>
        <p className="hint-text">
          {t("fuelStep.mismatchBody", { previous: t(`fuel.${lastFuelType}`), selected: t(`fuel.${pendingFuelType}`) })}
        </p>
        <div className="kiosk-actions" style={{ justifyContent: "center", gap: "1rem" }}>
          <button onClick={() => setPendingFuelType(null)}>{t("fuelStep.mismatchCancel")}</button>
          <button className="primary" onClick={() => onNext(pendingFuelType)}>
            {t("fuelStep.mismatchConfirm", { selected: t(`fuel.${pendingFuelType}`) })}
          </button>
        </div>
      </div>
    );
  }

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
              onClick={() => selectFuel(f.fuelType)}
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
