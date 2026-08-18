import { useState } from "react";
import type { FuelPrice } from "../../shared/types";
import { formatCurrency } from "../../shared/format";

export type AmountSelection =
  | { mode: "amount"; amount: number }
  | { mode: "liters"; liters: number }
  | { mode: "full_tank" };

const QUICK_AMOUNTS = [200, 500, 1000, 2000];

export default function AmountStep({
  price,
  onNext,
  onBack,
}: {
  price: FuelPrice;
  onNext: (selection: AmountSelection) => void;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<"amount" | "liters" | "full_tank">("amount");
  const [amount, setAmount] = useState<number | "">("");
  const [liters, setLiters] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    if (mode === "amount") {
      if (!amount || amount <= 0) return setError("Gecerli bir tutar giriniz.");
      onNext({ mode: "amount", amount });
    } else if (mode === "liters") {
      if (!liters || liters <= 0) return setError("Gecerli bir litre miktari giriniz.");
      onNext({ mode: "liters", liters });
    } else {
      onNext({ mode: "full_tank" });
    }
  }

  return (
    <div>
      <h2>Miktar Secin</h2>
      <div className="option-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <button className={`option-btn ${mode === "amount" ? "selected" : ""}`} onClick={() => setMode("amount")}>Tutar Gir</button>
        <button className={`option-btn ${mode === "liters" ? "selected" : ""}`} onClick={() => setMode("liters")}>Litre Gir</button>
        <button className={`option-btn ${mode === "full_tank" ? "selected" : ""}`} onClick={() => setMode("full_tank")}>Depoyu Doldur</button>
      </div>

      {mode === "amount" && (
        <>
          <div className="option-grid">
            {QUICK_AMOUNTS.map((q) => (
              <button key={q} className={`option-btn ${amount === q ? "selected" : ""}`} onClick={() => setAmount(q)}>
                {formatCurrency(q)}
              </button>
            ))}
          </div>
          <label>Ozel tutar (TL)</label>
          <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value ? Number(e.target.value) : "")} />
        </>
      )}

      {mode === "liters" && (
        <>
          <label>Litre miktari</label>
          <input type="number" min={0.1} step={0.1} value={liters} onChange={(e) => setLiters(e.target.value ? Number(e.target.value) : "")} />
          {liters !== "" && <p className="hint-text">Tahmini tutar: {formatCurrency(Number(liters) * price.pricePerLiter)}</p>}
        </>
      )}

      {mode === "full_tank" && (
        <p className="hint-text">Depo dolum sensoru algilandiginda otomatik olarak durdurulur. Maksimum tutar tahmini onceden gosterilir.</p>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="kiosk-actions">
        <button onClick={onBack}>Geri</button>
        <button className="primary" onClick={submit}>Devam Et</button>
      </div>
    </div>
  );
}
