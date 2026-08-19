import { Link } from "react-router-dom";
import { usePumps } from "../../shared/hooks";
import { PUMP_STATUS_LABEL, FUEL_LABEL, formatDateTime } from "../../shared/format";
import type { Pump, PumpStatus } from "../../shared/types";

const LEGEND: { status: PumpStatus; hint: string }[] = [
  { status: "idle", hint: "Kullanima hazir" },
  { status: "reserved", hint: "Musteri islem baslatti" },
  { status: "dispensing", hint: "Aktif dolum" },
  { status: "fault", hint: "Mudahale gerekiyor" },
  { status: "offline", hint: "Manuel olarak kapatildi" },
];

function PumpIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="10" height="17" rx="1.5" />
      <line x1="4" y1="9" x2="14" y2="9" />
      <path d="M14 8h3a2 2 0 0 1 2 2v7a1.5 1.5 0 0 0 3 0V9.5a1.5 1.5 0 0 0-.44-1.06L19 5.9" />
      <line x1="6.5" y1="12.5" x2="11.5" y2="12.5" />
      <line x1="6.5" y1="15.5" x2="11.5" y2="15.5" />
    </svg>
  );
}

export default function StationMap() {
  const { pumps } = usePumps();

  const counts = pumps.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <h2>İstasyon Haritası</h2>

      <div className="toolbar map-summary">
        <SummaryChip label="Toplam Pompa" value={pumps.length} />
        <SummaryChip label="Müsait" value={counts.idle ?? 0} tone="idle" />
        <SummaryChip label="Dolum Yapılıyor" value={counts.dispensing ?? 0} tone="dispensing" />
        <SummaryChip label="Arızalı" value={counts.fault ?? 0} tone="fault" />
        <SummaryChip label="Devre Dışı" value={counts.offline ?? 0} tone="offline" />
      </div>

      <div className="card">
        <div className="station-yard">
          <div className="station-canopy" />
          <span className="canopy-pole" style={{ left: "8%" }} />
          <span className="canopy-pole" style={{ left: "34%" }} />
          <span className="canopy-pole" style={{ left: "66%" }} />
          <span className="canopy-pole" style={{ left: "92%" }} />
          <div className="station-office">
            <span className="office-roof" />
            Ofis
          </div>
          <div className="lane-arrow lane-in">GİRİŞ ➜</div>
          <div className="lane-arrow lane-out">ÇIKIŞ ➜</div>

          {pumps.map((p) => (
            <PumpMarker key={p.id} pump={p} />
          ))}

          {pumps.length === 0 && <p className="hint-text station-empty">Bu istasyonda henüz pompa tanımlı değil.</p>}
        </div>

        <div className="map-legend">
          {LEGEND.map((item) => (
            <div className="map-legend-item" key={item.status}>
              <span className={`legend-dot ${item.status}`} />
              <div>
                <strong>{PUMP_STATUS_LABEL[item.status]}</strong>
                <span className="hint-text"> — {item.hint}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SummaryChip({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={`summary-chip ${tone ?? ""}`}>
      <span className="value">{value}</span>
      <span className="label">{label}</span>
    </div>
  );
}

function PumpMarker({ pump }: { pump: Pump }) {
  return (
    <Link to="/operator/pompalar" className={`pump-marker ${pump.status}`} style={{ left: `${pump.posX}%`, top: `${pump.posY}%` }}>
      {pump.status === "dispensing" && <span className="pulse-ring" />}
      <span className="pump-icon"><PumpIcon /></span>
      <span className="pump-number">{pump.number}</span>
      <span className="pump-status-pill">{PUMP_STATUS_LABEL[pump.status]}</span>

      <div className="pump-tooltip">
        <strong>{pump.label}</strong>
        <div className="hint-text">{PUMP_STATUS_LABEL[pump.status]}</div>
        <div className="tooltip-fuels">
          {pump.fuelTypes.map((f) => (
            <span className="fuel-chip" key={f}>{FUEL_LABEL[f]}</span>
          ))}
        </div>
        {pump.faultMessage && <div className="error-text">{pump.faultMessage}</div>}
        {pump.currentTransactionId && <div className="hint-text">Aktif işlem: #{pump.currentTransactionId}</div>}
        <div className="hint-text">Güncelleme: {formatDateTime(pump.updatedAt)}</div>
        <div className="tooltip-cta">Pompalar sayfasına git →</div>
      </div>
    </Link>
  );
}
