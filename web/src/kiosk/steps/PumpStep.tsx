import type { Pump } from "../../shared/types";
import { PUMP_STATUS_LABEL } from "../../shared/format";

export default function PumpStep({ pumps, onNext, onBack }: { pumps: Pump[]; onNext: (pump: Pump) => void; onBack: () => void }) {
  return (
    <div>
      <h2>Pompa Secin</h2>
      <p className="hint-text">Aracinizin bulundugu musait pompayi seciniz.</p>
      <div className="option-grid">
        {pumps.map((p) => {
          const disabled = p.status !== "idle";
          return (
            <button key={p.id} className="option-btn" disabled={disabled} onClick={() => onNext(p)}>
              <strong style={{ fontSize: "1.2rem" }}>{p.label}</strong>
              <br />
              <span className={`badge ${p.status}`}>{PUMP_STATUS_LABEL[p.status]}</span>
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
