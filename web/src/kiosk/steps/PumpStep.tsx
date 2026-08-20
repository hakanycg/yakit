import type { Pump } from "../../shared/types";
import { useKioskLang } from "../i18n";

export default function PumpStep({ pumps, onNext, onBack }: { pumps: Pump[]; onNext: (pump: Pump) => void; onBack: () => void }) {
  const { t } = useKioskLang();
  return (
    <div>
      <h2>{t("pump.title")}</h2>
      <p className="hint-text">{t("pump.subtitle")}</p>
      <div className="option-grid">
        {pumps.map((p) => {
          const disabled = p.status !== "idle";
          return (
            <button key={p.id} className="option-btn" disabled={disabled} onClick={() => onNext(p)}>
              <strong style={{ fontSize: "1.2rem" }}>{p.label}</strong>
              <br />
              <span className={`badge ${p.status}`}>{t(`pumpStatus.${p.status}`)}</span>
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
