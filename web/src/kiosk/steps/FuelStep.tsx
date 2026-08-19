import type { FuelPrice, FuelType, Pump } from "../../shared/types";
import { FUEL_LABEL, formatCurrency } from "../../shared/format";

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
  const available = fuelPrices.filter((f) => pump.fuelTypes.includes(f.fuelType));

  return (
    <div>
      <h2>Yakit Tipi Secin</h2>
      <p className="hint-text">{pump.label} icin desteklenen yakit tipleri.</p>
      <div className="option-grid">
        {available.map((f) => {
          const outOfStock = f.inStock === false;
          return (
            <button
              key={f.fuelType}
              className="option-btn"
              disabled={outOfStock}
              onClick={() => onNext(f.fuelType)}
              title={outOfStock ? "Bu yakit tipi su anda tukenmis." : undefined}
            >
              <strong>{FUEL_LABEL[f.fuelType] ?? f.label}</strong>
              <br />
              {outOfStock ? (
                <span className="error-text">Tukendi</span>
              ) : (
                <span className="hint-text">{formatCurrency(f.pricePerLiter)} / L</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="kiosk-actions">
        <button onClick={onBack}>Geri</button>
        <span />
      </div>
    </div>
  );
}
