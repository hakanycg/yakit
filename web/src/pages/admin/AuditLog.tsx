import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatDateTime } from "../../shared/format";
import type { AuditEntry } from "../../shared/types";

/** Personel oturumu OLMAYAN kayitlarin kimin adina yazildigi. */
const ACTOR_TYPE_LABEL: Record<string, string> = {
  fleet_portal: "filo portalı",
  system: "sistem",
  anonymous: "kimliği doğrulanmamış",
};

/** "Mozilla/5.0 (Windows NT 10.0...) Chrome/120..." -> "Chrome · Windows". */
function shortUserAgent(ua: string): string {
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" :
    /Firefox\//.test(ua) ? "Firefox" :
    ua.split(/[\s/]/)[0] || "Bilinmiyor";
  const os =
    /Windows/.test(ua) ? "Windows" :
    /Android/.test(ua) ? "Android" :
    /(iPhone|iPad|iOS)/.test(ua) ? "iOS" :
    /Mac OS X/.test(ua) ? "macOS" :
    /Linux/.test(ua) ? "Linux" : null;
  return os ? `${browser} · ${os}` : browser;
}

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
          placeholder="Eylem ile filtrele (örn: login_success)"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          style={{ maxWidth: 320 }}
        />
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Zaman</th>
              <th>Kullanıcı</th>
              <th>Eylem</th>
              <th>Varlık</th>
              <th>IP</th>
              <th>Cihaz</th>
              <th>Detay</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{formatDateTime(e.createdAt)}</td>
                <td>
                  {e.username ?? "-"}
                  {(e.role || (e.actorType && e.actorType !== "staff")) && (
                    <div className="hint-text" style={{ fontSize: "var(--fs-2xs)" }}>
                      {e.role ?? ACTOR_TYPE_LABEL[e.actorType!] ?? e.actorType}
                    </div>
                  )}
                </td>
                <td>{e.action}</td>
                <td>{e.entityType ? `${e.entityType}#${e.entityId}` : "-"}</td>
                <td>{e.ipAddress ?? "-"}</td>
                {/* Tarayici imzasi tam haliyle cok uzun; okunabilir kalsin diye kisaltilir,
                    tamamina ihtiyac duyulursa fare uzerine gelince gorunur. */}
                <td style={{ maxWidth: 180, overflowWrap: "break-word" }} title={e.userAgent ?? undefined}>
                  {e.userAgent ? <span className="hint-text">{shortUserAgent(e.userAgent)}</span> : "-"}
                </td>
                <td style={{ maxWidth: 320, overflowWrap: "break-word" }}>
                  {e.details ? <code style={{ fontSize: "0.78rem" }}>{JSON.stringify(e.details)}</code> : "-"}
                </td>
              </tr>
            ))}
            {entries.length === 0 && <tr><td colSpan={7} className="hint-text">Kayıt yok.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
