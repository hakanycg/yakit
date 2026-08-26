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
  // Degeri OKUNMAZ: amac 30 saniyede bir yeniden render tetikleyip vardiyanin gecen
  // suresini guncel tutmak. Diziden ilk eleman bilerek alinmiyor - okunmayan bir
  // degiskene isim vermek, birinin onu kullanmasi gerektigi izlenimi verirdi.
  const [, forceRerender] = useState(0);

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
    const interval = setInterval(() => forceRerender((t) => t + 1), 30000);
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
      setError(err instanceof ApiError ? err.message : "Vardiya başlatılamadı.");
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
      setError(err instanceof ApiError ? err.message : "Vardiya kapatılamadı.");
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
          <p className="hint-text">Yükleniyor...</p>
        ) : current ? (
          <>
            <div className="toolbar">
              <strong>Açık Vardiya</strong>
              <span className="badge dispensing">{current.displayName}</span>
              <div className="spacer" />
              <span className="hint-text">{durationLabel(current.startedAt, null)}</span>
            </div>
            <p className="hint-text" style={{ margin: "0.25rem 0" }}>Başlangıç: {formatDateTime(current.startedAt)}</p>
            {current.openingNote && <p className="hint-text">Not: {current.openingNote}</p>}

            <div className="grid cols-3" style={{ marginTop: "1rem" }}>
              <div className="stat">
                <span className="label">İşlem</span>
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
                <label style={{ marginTop: "1rem" }}>Kapanış notu (opsiyonel)</label>
                <input value={closingNote} onChange={(e) => setClosingNote(e.target.value)} />
                <button className="danger" style={{ marginTop: "0.75rem" }} disabled={busy} onClick={endShift}>
                  {busy ? "Kapatılıyor..." : "Vardiyayı Kapat"}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <p className="hint-text">Şu anda açık bir vardiyanız yok.</p>
            {canManage && (
              <>
                <label>Açılış notu (opsiyonel)</label>
                <input value={openingNote} onChange={(e) => setOpeningNote(e.target.value)} />
                <button className="primary" style={{ marginTop: "0.75rem" }} disabled={busy} onClick={startShift}>
                  {busy ? "Başlatılıyor..." : "Vardiya Başlat"}
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: 0 }}>Personel Performansı</h3>
          <div className="spacer" />
          <a href={appendStationParam("/api/shifts/summary/export.csv")}>
            <button>CSV İndir</button>
          </a>
        </div>
        <p className="hint-text" style={{ marginTop: "0.4rem" }}>
          Her personelin bütün vardiyaları toplamında sattığı litre/ciro; en çok satış yapan üstte listelenir.
        </p>
        <table>
          <thead>
            <tr><th>Personel</th><th>Vardiya Sayısı</th><th>İşlem</th><th>Ciro</th><th>Litre</th></tr>
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
                <td className="hint-text">— Vardiyasız Satışlar —</td>
                <td className="hint-text">-</td>
                <td>{unassigned.transactionCount}</td>
                <td>{formatCurrency(unassigned.revenue)}</td>
                <td>{formatLiters(unassigned.liters)}</td>
              </tr>
            )}
            {summary.length === 0 && (!unassigned || unassigned.transactionCount === 0) && (
              <tr><td colSpan={5} className="hint-text">Henüz kapatılmış vardiya yok.</td></tr>
            )}
          </tbody>
        </table>
        {unassigned && unassigned.transactionCount > 0 && (
          <p className="hint-text" style={{ marginTop: "0.5rem" }}>
            "Vardiyasız Satışlar": açık vardiya olmadan tamamlanan, hiçbir personele atfedilemeyen satışlar.
          </p>
        )}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
          <h3 style={{ margin: 0 }}>Vardiya Geçmişi</h3>
          <div className="spacer" />
          <a href={appendStationParam("/api/shifts/export.csv")}>
            <button>CSV İndir</button>
          </a>
        </div>
        <table>
          <thead>
            <tr><th>Personel</th><th>Başlangıç</th><th>Bitiş</th><th>Süre</th><th>İşlem</th><th>Ciro</th><th>Litre</th></tr>
          </thead>
          <tbody>
            {history.map((s) => (
              <tr key={s.id}>
                <td>{s.displayName}</td>
                <td>{formatDateTime(s.startedAt)}</td>
                <td>{s.endedAt ? formatDateTime(s.endedAt) : <span className="badge dispensing">Açık</span>}</td>
                <td>{durationLabel(s.startedAt, s.endedAt)}</td>
                <td>{s.stats?.transactionCount ?? 0}</td>
                <td>{formatCurrency(s.stats?.revenue ?? 0)}</td>
                <td>{formatLiters(s.stats?.liters ?? 0)}</td>
              </tr>
            ))}
            {history.length === 0 && <tr><td colSpan={7} className="hint-text">Kayıt yok.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
