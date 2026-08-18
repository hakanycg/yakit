import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatDateTime } from "../../shared/format";
import type { AuditEntry } from "../../shared/types";

export default function AuditLog() {
  const stationId = useEffectiveStationId();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actionFilter, setActionFilter] = useState("");

  useEffect(() => {
    if (stationId === null) return;
    const query = actionFilter ? `?action=${encodeURIComponent(actionFilter)}` : "";
    api.get<{ entries: AuditEntry[] }>(`/api/audit-log${query}`).then((res) => setEntries(res.entries));
  }, [actionFilter, stationId]);

  return (
    <div>
      <h2>Audit Log</h2>
      <div className="toolbar">
        <input
          placeholder="Eylem ile filtrele (orn: login_success)"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          style={{ maxWidth: 320 }}
        />
      </div>
      <div className="card">
        <table>
          <thead>
            <tr><th>Zaman</th><th>Kullanici</th><th>Eylem</th><th>Varlik</th><th>IP</th><th>Detay</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{formatDateTime(e.createdAt)}</td>
                <td>{e.username ?? "-"}</td>
                <td>{e.action}</td>
                <td>{e.entityType ? `${e.entityType}#${e.entityId}` : "-"}</td>
                <td>{e.ipAddress ?? "-"}</td>
                <td style={{ maxWidth: 320, overflowWrap: "break-word" }}>
                  {e.details ? <code style={{ fontSize: "0.78rem" }}>{JSON.stringify(e.details)}</code> : "-"}
                </td>
              </tr>
            ))}
            {entries.length === 0 && <tr><td colSpan={6} className="hint-text">Kayit yok.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
