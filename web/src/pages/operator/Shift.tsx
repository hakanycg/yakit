import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { appendStationParam } from "../../shared/stationScope";
import { useAuth } from "../../shared/AuthContext";
import { formatCurrency, formatDateTime, formatLiters } from "../../shared/format";

interface ShiftStats {
  transactionCount: number;
  revenue: number;
  liters: number;
}

interface StaffSummary {
  userId: number;
  username: string;
  displayName: string;
  shiftCount: number;
  transactionCount: number;
  revenue: number;
  liters: number;
}

interface Shift {
  id: number;
  stationId: number;
  userId: number;
  username: string;
  displayName: string;
  startedAt: string;
  endedAt: string | null;
  openingNote: string | null;
  closingNote: string | null;
  createdAt: string;
  stats: ShiftStats | null;
}

function durationLabel(startedAt: string, endedAt: string | null): string {
  const ms = (endedAt ? new Date(endedAt).getTime() : Date.now()) - new Date(startedAt).getTime();
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} sa ${minutes} dk`;
}

export default function Shift() {
  const { user } = useAuth();
  const stationId = useEffectiveStationId();
  const [current, setCurrent] = useState<Shift | null | undefined>(undefined);
  const [history, setHistory] = useState<Shift[]>([]);
  const [summary, setSummary] = useState<StaffSummary[]>([]);
  const [unassigned, setUnassigned] = useState<ShiftStats | null>(null);
  const [openingNote, setOpeningNote] = useState("");
  const [closingNote, setClosingNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const canManage = user?.role === "admin" || user?.role === "operator" || user?.role === "super_admin";

  function load() {
    if (stationId === null) return;
    api.get<{ shift: Shift | null }>("/api/shifts/current").then((res) => setCurrent(res.shift));
    api.get<{ shifts: Shift[] }>("/api/shifts").then((res) => setHistory(res.shifts));
    api.get<{ summary: StaffSummary[]; unassigned: ShiftStats }>("/api/shifts/summary").then((res) => {
      setSummary(res.summary);
      setUnassigned(res.unassigned);
    });
  }
  useEffect(load, [stationId]);

  useEffect(() => {
    if (!current) return;
    const interval = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(interval);
  }, [current]);

  async function startShift() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/shifts/start", { openingNote: openingNote.trim() || undefined });
      setOpeningNote("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Vardiya baslatilamadi.");
    } finally {
      setBusy(false);
    }
  }

  async function endShift() {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/shifts/${current.id}/end`, { closingNote: closingNote.trim() || undefined });
      setClosingNote("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Vardiya kapatilamadi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Vardiya</h2>
      {error && <p className="error-text">{error}</p>}

      <div className="card" style={{ maxWidth: 560 }}>
        {current === undefined ? (
          <p className="hint-text">Yukleniyor...</p>
        ) : current ? (
          <>
            <div className="toolbar">
              <strong>Acik Vardiya</strong>
              <span className="badge dispensing">{current.displayName}</span>
              <div className="spacer" />
              <span className="hint-text">{durationLabel(current.startedAt, null)}</span>
            </div>
            <p className="hint-text" style={{ margin: "0.25rem 0" }}>Baslangic: {formatDateTime(current.startedAt)}</p>
            {current.openingNote && <p className="hint-text">Not: {current.openingNote}</p>}

            <div className="grid cols-3" style={{ marginTop: "1rem" }}>
              <div className="stat">
                <span className="label">Islem</span>
                <span className="value">{current.stats?.transactionCount ?? 0}</span>
              </div>
              <div className="stat">
                <span className="label">Ciro</span>
                <span className="value">{formatCurrency(current.stats?.revenue ?? 0)}</span>
              </div>
              <div className="stat">
                <span className="label">Litre</span>
                <span className="value">{formatLiters(current.stats?.liters ?? 0)}</span>
              </div>
            </div>

            {canManage && (current.userId === user?.id || user?.role !== "operator") && (
              <>
                <label style={{ marginTop: "1rem" }}>Kapanis notu (opsiyonel)</label>
                <input value={closingNote} onChange={(e) => setClosingNote(e.target.value)} />
                <button className="danger" style={{ marginTop: "0.75rem" }} disabled={busy} onClick={endShift}>
                  {busy ? "Kapatiliyor..." : "Vardiyayi Kapat"}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <p className="hint-text">Su anda acik bir vardiyaniz yok.</p>
            {canManage && (
              <>
                <label>Acilis notu (opsiyonel)</label>
                <input value={openingNote} onChange={(e) => setOpeningNote(e.target.value)} />
                <button className="primary" style={{ marginTop: "0.75rem" }} disabled={busy} onClick={startShift}>
                  {busy ? "Baslatiliyor..." : "Vardiya Baslat"}
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: 0 }}>Personel Performansi</h3>
          <div className="spacer" />
          <a href={appendStationParam("/api/shifts/summary/export.csv")}>
            <button>CSV Indir</button>
          </a>
        </div>
        <p className="hint-text" style={{ marginTop: "0.4rem" }}>
          Her personelin butun vardiyalari toplaminda sattigi litre/ciro; en cok satis yapan ustte listelenir.
        </p>
        <table>
          <thead>
            <tr><th>Personel</th><th>Vardiya Sayisi</th><th>Islem</th><th>Ciro</th><th>Litre</th></tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <tr key={s.userId}>
                <td>{s.displayName}</td>
                <td>{s.shiftCount}</td>
                <td>{s.transactionCount}</td>
                <td>{formatCurrency(s.revenue)}</td>
                <td>{formatLiters(s.liters)}</td>
              </tr>
            ))}
            {unassigned && unassigned.transactionCount > 0 && (
              <tr>
                <td className="hint-text">— Vardiyasiz Satislar —</td>
                <td className="hint-text">-</td>
                <td>{unassigned.transactionCount}</td>
                <td>{formatCurrency(unassigned.revenue)}</td>
                <td>{formatLiters(unassigned.liters)}</td>
              </tr>
            )}
            {summary.length === 0 && (!unassigned || unassigned.transactionCount === 0) && (
              <tr><td colSpan={5} className="hint-text">Henuz kapatilmis vardiya yok.</td></tr>
            )}
          </tbody>
        </table>
        {unassigned && unassigned.transactionCount > 0 && (
          <p className="hint-text" style={{ marginTop: "0.5rem" }}>
            "Vardiyasiz Satislar": acik vardiya olmadan tamamlanan, hicbir personele atfedilemeyen satislar. Bunlar
            olustugunda Alarm Merkezi'nde bir uyari olusur; bir vardiya acildiginda bu uyari otomatik kapanir.
          </p>
        )}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
          <h3 style={{ margin: 0 }}>Vardiya Gecmisi</h3>
          <div className="spacer" />
          <a href={appendStationParam("/api/shifts/export.csv")}>
            <button>CSV Indir</button>
          </a>
        </div>
        <table>
          <thead>
            <tr><th>Personel</th><th>Baslangic</th><th>Bitis</th><th>Sure</th><th>Islem</th><th>Ciro</th><th>Litre</th></tr>
          </thead>
          <tbody>
            {history.map((s) => (
              <tr key={s.id}>
                <td>{s.displayName}</td>
                <td>{formatDateTime(s.startedAt)}</td>
                <td>{s.endedAt ? formatDateTime(s.endedAt) : <span className="badge dispensing">Acik</span>}</td>
                <td>{durationLabel(s.startedAt, s.endedAt)}</td>
                <td>{s.stats?.transactionCount ?? 0}</td>
                <td>{formatCurrency(s.stats?.revenue ?? 0)}</td>
                <td>{formatLiters(s.stats?.liters ?? 0)}</td>
              </tr>
            ))}
            {history.length === 0 && <tr><td colSpan={7} className="hint-text">Kayit yok.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
