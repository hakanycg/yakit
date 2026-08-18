import { useState } from "react";
import { kioskApi } from "../kioskApi";

const SAMPLE_PLATES = ["06 ABC 123", "34 XY 4567", "35 CDE 89", "16 FGH 12", "42 KL 456"];

export default function PlateStep({ onNext }: { onNext: (plate: string, source: "manual" | "lpr") => void }) {
  const [plate, setPlate] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    setError(null);
    const sample = SAMPLE_PLATES[Math.floor(Math.random() * SAMPLE_PLATES.length)]!;
    await new Promise((r) => setTimeout(r, 1400));
    try {
      const res = await kioskApi.recognizePlate(sample);
      if (res.valid) {
        setPlate(res.plate);
      } else {
        setError("Plaka net okunamadi, lutfen manuel giriniz.");
      }
    } finally {
      setScanning(false);
    }
  }

  function submitManual() {
    setError(null);
    const normalized = plate.toUpperCase().trim();
    if (!/^[A-Z0-9 ]{5,12}$/.test(normalized)) {
      setError("Gecerli bir plaka giriniz (orn: 06 ABC 123).");
      return;
    }
    onNext(normalized, "manual");
  }

  return (
    <div>
      <h2>Hosgeldiniz</h2>
      <p className="hint-text">Baslamak icin arac plakanizi girin veya otomatik plaka tanima (LPR) ile taratin.</p>

      <label>Plaka</label>
      <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="06 ABC 123" style={{ fontSize: "1.3rem", textAlign: "center", letterSpacing: "0.1em" }} />
      {error && <p className="error-text">{error}</p>}

      <div className="kiosk-actions">
        <button onClick={scan} disabled={scanning}>
          {scanning ? "Kamera taraniyor..." : "LPR ile Otomatik Tara"}
        </button>
        <button className="primary" onClick={submitManual} disabled={scanning}>
          Devam Et
        </button>
      </div>
      <p className="hint-text">Not: Bu ortamda fiziksel kamera donanimi bulunmadigindan LPR taramasi simule edilmektedir.</p>
    </div>
  );
}
