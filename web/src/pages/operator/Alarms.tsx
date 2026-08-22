import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useTopicSubscription } from "../../shared/useWebSocket";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { ALARM_SEVERITY_LABEL, ALARM_STATUS_LABEL, formatDateTime } from "../../shared/format";
import type { Alarm } from "../../shared/types";
import { useAuth } from "../../shared/AuthContext";

export default function Alarms() {
  const { user } = useAuth();
  const stationId = useEffectiveStationId();
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [statusFilter, setStatusFilter] = useState<"active" | "acknowledged" | "resolved" | "">("active");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (stationId === null) return;
    const query = statusFilter ? `?status=${statusFilter}` : "";
    api.get<{ alarms: Alarm[] }>(`/api/alarms${query}`).then((res) => setAlarms(res.alarms));
  }

  useEffect(load, [statusFilter, stationId]);
  useTopicSubscription(stationId !== null ? `alarms:${stationId}` : null, () => load());

  const canManage = user?.role === "admin" || user?.role === "operator" || user?.role === "super_admin";

  async function act(id: number, action: "acknowledge" | "resolve") {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/api/alarms/${id}/${action}`, {});
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İşlem başarısız.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h2>Alarm Merkezi</h2>
      <div className="toolbar">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} style={{ width: 220 }}>
          <option value="active">Aktif</option>
          <option value="acknowledged">Onaylandı</option>
          <option value="resolved">Çözüldü</option>
          <option value="">Tümü</option>
        </select>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="card">
        <table>
          <thead>
            <tr><th>Önem</th><th>Tip</th><th>Mesaj</th><th>Durum</th><th>Zaman</th>{canManage && <th>İşlem</th>}</tr>
          </thead>
          <tbody>
            {alarms.map((a) => (
              <tr key={a.id}>
                <td><span className={`badge ${a.severity}`}>{ALARM_SEVERITY_LABEL[a.severity]}</span></td>
                <td>{a.type}</td>
                <td>
                  {a.message}
                  {a.type === "pump_fault" && a.status !== "resolved" && (
                    <div className="hint-text">"Çöz" ile kapatmak ilgili pompayı da otomatik olarak kullanıma açar.</div>
                  )}
                </td>
                <td><span className={`badge ${a.status}`}>{ALARM_STATUS_LABEL[a.status]}</span></td>
                <td>{formatDateTime(a.createdAt)}</td>
                {canManage && (
                  <td>
                    <div className="toolbar" style={{ margin: 0 }}>
                      {a.status === "active" && (
                        <button disabled={busyId === a.id} onClick={() => act(a.id, "acknowledge")}>Onayla</button>
                      )}
                      {a.status !== "resolved" && (
                        <button disabled={busyId === a.id} className="success" onClick={() => act(a.id, "resolve")}>Çöz</button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {alarms.length === 0 && <tr><td colSpan={canManage ? 6 : 5} className="hint-text">Kayıt yok.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
