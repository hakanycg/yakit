import { useState } from "react";
import { kioskApi } from "../kioskApi";
import { formatCurrency } from "../../shared/format";
import { useKioskLang } from "../i18n";
import { KioskInput } from "../KioskKeyboard";
import { ApiError } from "../../shared/api";

const SAMPLE_PLATES = ["06 ABC 123", "34 XY 4567", "35 CDE 89", "16 FGH 12", "42 KL 456"];

export default function PlateStep({
  stationId,
  referralEnabled,
  onNext,
}: {
  stationId: number;
  referralEnabled: boolean;
  onNext: (plate: string, source: "manual" | "lpr", referrerPlate?: string) => void;
}) {
  const { t, locale } = useKioskLang();
  const [plate, setPlate] = useState("");
  const [referrerPlate, setReferrerPlate] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Musteri dolum akisina hic girmeden, sirf plakasindaki sadakat puanini merak edip
  // sorabilmeli - bugune kadar bu sorgu yalnizca AmountStep'te (dolum tutari secildikten
  // SONRA) yapiliyordu, yani puanini gormek icin once pompa/yakit adimlarindan gecmek
  // gerekiyordu.
  const [loyaltyChecking, setLoyaltyChecking] = useState(false);
  const [loyaltyResult, setLoyaltyResult] = useState<{ enabled: boolean; points: number; valueTry: number; tier: "bronze" | "silver" | "gold" | null } | null>(null);
  const [loyaltyError, setLoyaltyError] = useState<string | null>(null);

  async function checkLoyalty() {
    setLoyaltyError(null);
    setLoyaltyResult(null);
    const normalized = plate.toUpperCase().trim();
    if (!/^[A-Z0-9 ]{5,12}$/.test(normalized)) {
      setLoyaltyError(t("plate.invalid"));
      return;
    }
    setLoyaltyChecking(true);
    try {
      const res = await kioskApi.getLoyaltyBalance(stationId, normalized);
      setLoyaltyResult(res);
    } catch (err) {
      setLoyaltyError(err instanceof ApiError ? err.message : t("plate.loyaltyError"));
    } finally {
      setLoyaltyChecking(false);
    }
  }

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
    const normalizedReferrer = referrerPlate.toUpperCase().trim();
    onNext(normalized, "manual", normalizedReferrer || undefined);
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
        onChange={(next) => {
          setPlate(next.toUpperCase());
          setLoyaltyResult(null);
          setLoyaltyError(null);
        }}
        placeholder={t("plate.placeholder")}
        maxLength={12}
        ltr
        style={{ fontSize: "1.3rem", textAlign: "center", letterSpacing: "0.1em" }}
      />
      {error && <p className="error-text">{error}</p>}

      {referralEnabled && (
        <div style={{ marginTop: "0.75rem" }}>
          <label>{t("plate.referrerLabel")}</label>
          <KioskInput
            layout="plate"
            value={referrerPlate}
            onChange={(next) => setReferrerPlate(next.toUpperCase())}
            placeholder={t("plate.referrerPlaceholder")}
            maxLength={12}
            ltr
            style={{ fontSize: "1rem", textAlign: "center", letterSpacing: "0.08em" }}
          />
          <p className="hint-text" style={{ marginTop: "0.25rem" }}>
            {t("plate.referrerHint")}
          </p>
        </div>
      )}

      <div className="kiosk-actions">
        <button onClick={scan} disabled={scanning}>
          {scanning ? t("plate.scanning") : t("plate.scanButton")}
        </button>
        <button className="primary" onClick={submitManual} disabled={scanning}>
          {t("plate.continue")}
        </button>
      </div>

      <div className="kiosk-actions">
        <button type="button" onClick={checkLoyalty} disabled={loyaltyChecking || !plate.trim()}>
          {loyaltyChecking ? t("plate.loyaltyChecking") : t("plate.loyaltyCheckButton")}
        </button>
      </div>
      {loyaltyError && <p className="error-text">{loyaltyError}</p>}
      {loyaltyResult && (
        <p className="hint-text" style={{ color: "var(--k-accent-2)" }}>
          {loyaltyResult.enabled
            ? t("plate.loyaltyResult", { points: loyaltyResult.points, value: formatCurrency(loyaltyResult.valueTry, locale) })
            : t("plate.loyaltyDisabled")}
          {loyaltyResult.enabled && loyaltyResult.tier && ` — ${t(`loyalty.tier.${loyaltyResult.tier}`)}`}
        </p>
      )}

      <p className="hint-text">{t("plate.lprNote")}</p>
    </div>
  );
}
