import { useEffect, useState } from "react";
import { kioskApi } from "./kioskApi";
import { useKioskLang } from "./i18n";
import { formatCurrency } from "../shared/format";
import type { FuelPrice, FuelType } from "../shared/types";

interface Campaign {
  code: string;
  type: "percent" | "fixed";
  value: number;
  fuelType: FuelType | null;
}

type Slide = { kind: "price"; price: FuelPrice } | { kind: "campaign"; campaign: Campaign };

/**
 * Karsilama ekraninda uzun sure kimse etkilesime gecmezse (bkz. useAttractMode)
 * gecmekte olan bir musteriyi cekmek icin gosterilen tam ekran bindirme: guncel
 * yakit fiyatlari ve aktif kampanyalar sirayla donuyor. Herhangi bir dokunma/
 * tiklama, useAttractMode'un kendi etkilesim dinleyicileri sayesinde bu ekrani
 * aninda kapatip normal karsilama ekranina doner.
 */
export default function AttractMode({ stationId, stationName, fuelPrices }: { stationId: number; stationName: string; fuelPrices: FuelPrice[] }) {
  const { t, locale } = useKioskLang();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    kioskApi
      .getActiveCampaigns(stationId)
      .then((res) => setCampaigns(res.campaigns))
      .catch(() => setCampaigns([]));
  }, [stationId]);

  const slides: Slide[] = [
    ...fuelPrices.map((price) => ({ kind: "price" as const, price })),
    ...campaigns.map((campaign) => ({ kind: "campaign" as const, campaign })),
  ];

  useEffect(() => {
    if (slides.length < 2) return;
    const interval = setInterval(() => setIndex((i) => (i + 1) % slides.length), 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides.length]);

  if (slides.length === 0) return null;
  const slide = slides[index % slides.length]!;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 40,
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <p className="hint-text" style={{ fontSize: "1.2rem" }}>{stationName}</p>
      {slide.kind === "price" ? (
        <>
          <h1 style={{ fontSize: "3rem", margin: "1rem 0" }}>{t(`fuel.${slide.price.fuelType}`)}</h1>
          <p style={{ fontSize: "4rem", fontWeight: 700, color: "var(--accent)", margin: 0 }}>
            {formatCurrency(slide.price.pricePerLiter, locale)} / L
          </p>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: "2.2rem", margin: "1rem 0" }}>{t("attract.campaignTitle")}</h1>
          <p style={{ fontSize: "2.2rem", fontWeight: 700, color: "var(--accent-2)", margin: 0 }} dir="ltr">
            {slide.campaign.code}
          </p>
          <p className="hint-text" style={{ fontSize: "1.3rem" }}>
            {slide.campaign.type === "percent"
              ? t("attract.percentOff", { value: slide.campaign.value })
              : t("attract.fixedOff", { value: formatCurrency(slide.campaign.value, locale) })}
          </p>
        </>
      )}
      <p className="hint-text" style={{ marginTop: "3rem", fontSize: "1.1rem" }}>{t("attract.tapToStart")}</p>
    </div>
  );
}
