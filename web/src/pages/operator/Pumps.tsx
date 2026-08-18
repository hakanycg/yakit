import { useState } from "react";
import { usePumps } from "../../shared/hooks";
import { api, ApiError } from "../../shared/api";
import { PUMP_STATUS_LABEL, FUEL_LABEL, formatDateTime } from "../../shared/format";
import { useAuth } from "../../shared/AuthContext";
import type { Pump } from "../../shared/types";

export default function Pumps() {
  const { pumps } = usePumps();
  const { user } = useAuth();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [faultTarget, setFaultTarget] = useState<Pump | null>(null);

  const canOperate = user?.role === "admin" || user?.role === "operator";

  async function runAction(id: number, action: "start" | "stop" | "reset") {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/api/pumps/${id}/${action}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Islem basarisiz.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h2>Pompalar</h2>
      {error && <p className="error-text">{error}</p>}
      <div className="grid cols-2">
        {pumps.map((p) => (
          <div className="card" key={p.id}>
            <div className="toolbar">
              <strong>{p.label}</strong>
              <span className={`badge ${p.status}`}>{PUMP_STATUS_LABEL[p.status]}</span>
              <div className="spacer" />
              <span className="hint-text">Guncelleme: {formatDateTime(p.updatedAt)}</span>
            </div>
            <p className="hint-text">Desteklenen yakitlar: {p.fuelTypes.map((f) => FUEL_LABEL[f]).join(", ")}</p>
            {p.faultMessage && <p className="error-text">Ariza: {p.faultMessage} ({p.faultCode})</p>}
            {p.currentTransactionId && <p className="hint-text">Aktif islem: #{p.currentTransactionId}</p>}

            {canOperate && (
              <div className="toolbar" style={{ marginTop: "0.75rem" }}>
                <button disabled={busyId === p.id || p.status === "idle"} onClick={() => runAction(p.id, "start")}>
                  Baslat
                </button>
                <button disabled={busyId === p.id} onClick={() => runAction(p.id, "stop")}>
                  Durdur
                </button>
                <button disabled={busyId === p.id} onClick={() => runAction(p.id, "reset")}>
                  Reset
                </button>
                <button disabled={busyId === p.id} className="danger" onClick={() => setFaultTarget(p)}>
                  Ariza Simule Et
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {faultTarget && <FaultDialog pump={faultTarget} onClose={() => setFaultTarget(null)} />}
    </div>
  );
}

function FaultDialog({ pump, onClose }: { pump: Pump; onClose: () => void }) {
  const [faultCode, setFaultCode] = useState("E-101");
  const [faultMessage, setFaultMessage] = useState("Nozul sensoru yanit vermiyor");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/pumps/${pump.id}/simulate-fault`, { faultCode, faultMessage });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Islem basarisiz.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}>
      <div className="card" style={{ width: 420 }}>
        <h3 style={{ marginTop: 0 }}>{pump.label} - Ariza Simulasyonu</h3>
        <label>Ariza Kodu</label>
        <input value={faultCode} onChange={(e) => setFaultCode(e.target.value)} />
        <label>Ariza Mesaji</label>
        <input value={faultMessage} onChange={(e) => setFaultMessage(e.target.value)} />
        {error && <p className="error-text">{error}</p>}
        <div className="toolbar" style={{ marginTop: "1.25rem" }}>
          <button onClick={onClose} disabled={submitting}>Vazgec</button>
          <div className="spacer" />
          <button className="danger" onClick={submit} disabled={submitting}>
            {submitting ? "Uygulaniyor..." : "Ariza Olustur"}
          </button>
        </div>
      </div>
    </div>
  );
}
