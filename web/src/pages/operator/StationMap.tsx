import { usePumps } from "../../shared/hooks";
import { PUMP_STATUS_LABEL } from "../../shared/format";

export default function StationMap() {
  const { pumps } = usePumps();

  return (
    <div>
      <h2>Istasyon Haritasi</h2>
      <div className="card">
        <div className="pump-map">
          {pumps.map((p) => (
            <div key={p.id} className={`pump-marker ${p.status}`} style={{ left: `${p.posX}%`, top: `${p.posY}%` }}>
              <strong>{p.label}</strong>
              <span>{PUMP_STATUS_LABEL[p.status]}</span>
            </div>
          ))}
        </div>
        <p className="hint-text" style={{ marginTop: "1rem" }}>
          Renkler pompa durumunu gosterir: yesil = dolum yapiliyor, sari = rezerve, kirmizi = ariza, gri = devre disi.
        </p>
      </div>
    </div>
  );
}
