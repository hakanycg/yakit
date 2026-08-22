import { useEffect, useState } from "react";
import { kioskApi } from "./kioskApi";
import { useKioskLang } from "./i18n";
import { formatCurrency, formatDateTime } from "../shared/format";
import type { FuelPrice } from "../shared/types";

interface HistoryPoint {
  pricePerLiter: number;
  changedAt: string;
}

/** Fiyat seffafligi: son 30 gunun fiyat degisim gecmisini gosterir - musteri guveni icin. */
export default function PriceHistoryLink({ stationId, fuelPrices }: { stationId: number; fuelPrices: FuelPrice[] }) {
  const { t, locale } = useKioskLang();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    Promise.all(
      fuelPrices.map((f) => kioskApi.getPriceHistory(stationId, f.fuelType).then((res) => [f.fuelType, res.history] as const))
    ).then((entries) => {
      setHistory(Object.fromEntries(entries));
      setLoaded(true);
    });
  }, [open, loaded, stationId, fuelPrices]);

  return (
    <>
      <button type="button" className="kiosk-privacy-link" onClick={() => setOpen(true)}>
        {t("priceHistory.linkLabel")}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
          onClick={() => setOpen(false)}
        >
          <div className="kiosk-card" style={{ width: "min(560px, 92vw)", maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{t("priceHistory.title")}</h3>
            {fuelPrices.map((f) => (
              <div key={f.fuelType} style={{ marginBottom: "1.25rem" }}>
                <div className="toolbar">
                  <strong>{t(`fuel.${f.fuelType}`)}</strong>
                  <div className="spacer" />
                  <span>{formatCurrency(f.pricePerLiter, locale)}</span>
                </div>
                <PriceSparkline points={history[f.fuelType] ?? []} />
              </div>
            ))}
            {!loaded && <p className="hint-text">{t("loading")}</p>}
            <div className="toolbar" style={{ marginTop: "1rem" }}>
              <div className="spacer" />
              <button className="primary" onClick={() => setOpen(false)}>{t("priceHistory.close")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PriceSparkline({ points }: { points: HistoryPoint[] }) {
  const { t, locale } = useKioskLang();
  if (points.length < 2) {
    return <p className="hint-text">{t("priceHistory.noHistory")}</p>;
  }

  const width = 480;
  const height = 60;
  const pad = 6;
  const prices = points.map((p) => p.pricePerLiter);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (points.length - 1);
  const coords = points.map((p, i) => ({
    x: pad + i * stepX,
    y: height - pad - ((p.pricePerLiter - min) / range) * (height - pad * 2),
    p,
  }));
  const linePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");

  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "60px", display: "block" }} preserveAspectRatio="none">
        <polyline points={linePoints} fill="none" stroke="#60a5fa" strokeWidth="2" />
        {coords.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r="2.5" fill="#60a5fa">
            <title>{`${formatDateTime(c.p.changedAt, locale)}: ${formatCurrency(c.p.pricePerLiter, locale)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="toolbar hint-text" style={{ marginTop: "0.2rem", fontSize: "0.7rem" }}>
        <span>{formatDateTime(points[0]!.changedAt, locale)}</span>
        <div className="spacer" />
        <span>{formatDateTime(points[points.length - 1]!.changedAt, locale)}</span>
      </div>
    </>
  );
}
