import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatDateTime } from "../../shared/format";
import StationCombobox from "../../shared/StationCombobox";
import type { AuditEntry, Station } from "../../shared/types";

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

/**
 * Detay sutunu.
 *
 * Ham JSON basiliyordu ve icindeki null'lar ("action":null gibi) logu okuyan kisiye
 * "veri eksik" izlenimi veriyordu; oysa anlami "o suzgec kullanilmadi" idi. Bos
 * degerler artik hic gosterilmiyor - eski kayitlarda da (sunucu tarafi duzeltmesi
 * yalnizca yeni kayitlari etkiler).
 */
/**
 * Bos degerleri HER DERINLIKTE atar.
 *
 * Ust seviyeyi suzmek yetmiyordu: detay bir dizi ya da ic ice bir nesne oldugunda
 * JSON.stringify icerideki null'lari yine metne cevirip ekrana basiyordu. Temizlik
 * basim noktasinda degil, veri agacinin tamaminda yapilmali - aksi halde her yeni
 * recordAudit cagiran yer bu tuzagi yeniden acabilir.
 */
function stripEmpty(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) {
    const items = value.map(stripEmpty).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, stripEmpty(v)] as const)
      .filter(([, v]) => v !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

function AuditDetails({ details }: { details: unknown }) {
  const cleaned = stripEmpty(details);
  if (cleaned === undefined) return <span className="hint-text">-</span>;
  if (typeof cleaned !== "object") {
    return <code style={{ fontSize: "var(--fs-2xs)" }}>{String(cleaned)}</code>;
  }
  if (Array.isArray(cleaned)) {
    return <code style={{ fontSize: "var(--fs-2xs)" }}>{JSON.stringify(cleaned)}</code>;
  }

  return (
    <span className="audit-detail-list">
      {Object.entries(cleaned as Record<string, unknown>).map(([k, v]) => (
        <span className="audit-detail-item" key={k}>
          <span className="audit-detail-key">{k}</span>
          <span className="audit-detail-value">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
        </span>
      ))}
    </span>
  );
}

export default function AuditLog() {
  const stationId = useEffectiveStationId();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actionFilter, setActionFilter] = useState("");
  const [entityTypeFilter, setEntityTypeFilter] = useState("");
  const [entityIdFilter, setEntityIdFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // null = "tum istasyonlar" (yalnizca super_admin gorebilir, bkz. routes/auditLog.ts) -
  // sayfanin KENDI secimidir, uygulamanin geneli icin secili olan istasyondan BAGIMSIZDIR
  // (bkz. api.ts'teki { unscoped: true } - sidebar'daki sabit karti etkilemez).
  const [stationFilter, setStationFilter] = useState<Station | null>(null);

  useEffect(() => {
    if (stationId === null) return;
    const params = new URLSearchParams();
    if (actionFilter.trim()) params.set("action", actionFilter.trim());
    if (entityTypeFilter.trim()) params.set("entityType", entityTypeFilter.trim());
    if (entityIdFilter.trim()) params.set("entityId", entityIdFilter.trim());
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    if (stationFilter) params.set("stationId", String(stationFilter.id));
    const query = params.toString() ? `?${params.toString()}` : "";
    api
      .get<{ entries: AuditEntry[] }>(`/api/audit-log${query}`, { unscoped: true })
      .then((res) => setEntries(res.entries));
  }, [actionFilter, entityTypeFilter, entityIdFilter, dateFrom, dateTo, stationFilter, stationId]);

  return (
    <div>
      <h2>Audit Log</h2>
      <div className="toolbar">
        <input
          placeholder="Eylem ile filtrele (örn: login_success)"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <input
          placeholder="Varlık tipi (örn: transaction)"
          value={entityTypeFilter}
          onChange={(e) => setEntityTypeFilter(e.target.value)}
          style={{ maxWidth: 200 }}
        />
        <input
          placeholder="Varlık kimliği"
          value={entityIdFilter}
          onChange={(e) => setEntityIdFilter(e.target.value)}
          style={{ maxWidth: 140 }}
        />
        <label htmlFor="audit-date-from" style={{ margin: 0 }}>
          Başlangıç
        </label>
        <input id="audit-date-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ maxWidth: 150 }} />
        <label htmlFor="audit-date-to" style={{ margin: 0 }}>
          Bitiş
        </label>
        <input id="audit-date-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ maxWidth: 150 }} />
        <div style={{ minWidth: 220 }}>
          <StationCombobox
            value={stationFilter}
            onSelect={setStationFilter}
            placeholder="Tüm istasyonlar (aramak için yazın)"
          />
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Zaman</th>
              <th>İstasyon</th>
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
                {/* "Tum istasyonlar" goruntulenirken (bkz. yukaridaki istasyon suzgeci)
                    satirlar birbirinden farkli istasyonlara ait olabilir - hangisine ait
                    oldugu burada gorunmeli, aksi halde karistirilirdi. */}
                <td>{e.stationName ?? <span className="hint-text">-</span>}</td>
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
                <td style={{ maxWidth: 340, overflowWrap: "break-word" }}>
                  <AuditDetails details={e.details} />
                </td>
              </tr>
            ))}
            {entries.length === 0 && <tr><td colSpan={8} className="hint-text">Kayıt yok.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
