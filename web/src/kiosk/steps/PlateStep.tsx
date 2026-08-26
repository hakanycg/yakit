import { useState } from "react";
import { kioskApi } from "../kioskApi";
import { useKioskLang } from "../i18n";
import { KioskInput } from "../KioskKeyboard";

const SAMPLE_PLATES = ["06 ABC 123", "34 XY 4567", "35 CDE 89", "16 FGH 12", "42 KL 456"];

export default function PlateStep({ onNext }: { onNext: (plate: string, source: "manual" | "lpr") => void }) {
  const { t } = useKioskLang();
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
        setError(t("plate.lprFailed"));
      }
    } finally {
      setScanning(false);
    }
  }

  function submitManual() {
    setError(null);
    const normalized = plate.toUpperCase().trim();
    if (!/^[A-Z0-9 ]{5,12}$/.test(normalized)) {
      setError(t("plate.invalid"));
      return;
    }
    onNext(normalized, "manual");
  }

  return (
    <div>
      <h2>{t("plate.title")}</h2>
      <p className="hint-text">{t("plate.subtitle")}</p>

      <label>{t("plate.label")}</label>
      {/* Sistem klavyesi degil kiosk klavyesi acilir - bkz. KioskKeyboard.tsx.
          Plakalar arayuz dili ne olursa olsun her zaman soldan saga yazilir (harf+rakam
          karisimi, RTL bir sayfada - ör. Arapca'da - ters sirada gorunmesin diye). */}
      <KioskInput
        layout="plate"
        value={plate}
        onChange={(next) => setPlate(next.toUpperCase())}
        placeholder={t("plate.placeholder")}
        maxLength={12}
        ltr
        style={{ fontSize: "1.3rem", textAlign: "center", letterSpacing: "0.1em" }}
      />
      {error && <p className="error-text">{error}</p>}

      <div className="kiosk-actions">
        <button onClick={scan} disabled={scanning}>
          {scanning ? t("plate.scanning") : t("plate.scanButton")}
        </button>
        <button className="primary" onClick={submitManual} disabled={scanning}>
          {t("plate.continue")}
        </button>
      </div>
      <p className="hint-text">{t("plate.lprNote")}</p>
    </div>
  );
}
