import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import { AlertIcon, CheckCircleIcon, FuelIcon, WalletIcon } from "../../shared/icons";

/**
 * Konsolide (cok istasyonlu) rapor.
 *
 * Mevcut raporlama tek istasyona bakiyordu; 40 istasyonu olan bir dagitici toplam
 * cirosunu gormek icin 40 istasyonu tek tek gezmek zorundaydi.
 *
 * Tarih araligi mutabakatla AYNI is gunu tanimini kullanir (Turkiye UTC+3): iki
 * ekranin "bugun"u farkli anlamasi, ayni gun icin farkli rakamlar demek olurdu.
 */

interface PortfolioStation {
  stationId: number;
  stationName: string;
  stationCode: string | null;
  active: number;
  transactionCount: number;
  revenue: number;
  discount: number;
  liters: number;
  activeAlarms: number;
  criticalAlarms: number;
  openSupportRequests: number;
  varianceLiters: number | null;
  lastSyncedAt: string | null;
}

interface PortfolioReport {
  from: string;
  to: string;
  stations: PortfolioStation[];
  totals: {
    stationCount: number;
    activeStationCount: number;
    transactionCount: number;
    revenue: number;
    discount: number;
    liters: number;
    activeAlarms: number;
    criticalAlarms: number;
    openSupportRequests: number;
    varianceLiters: number;
  };
}

/** Turkiye UTC+3; is gunu yerel gece yarisinda baslar. */
function businessDate(daysAgo = 0): string {
  return new Date(Date.now() + 3 * 3600_000 - daysAgo * 86400_000).toISOString().slice(0, 10);
}

export default function Portfolio() {
  const [from, setFrom] = useState(() => businessDate(29));
  const [to, setTo] = useState(() => businessDate(0));
  const [report, setReport] = useState<PortfolioReport | null>(null);

  useEffect(() => {
    api.get<{ report: PortfolioReport }>(`/api/portfolio?from=${from}&to=${to}`).then((res) => setReport(res.report));
  }, [from, to]);

  const t = report?.totals;

  return (
    <div>
      <h2>Konsolide Rapor</h2>
      <p className="hint-text">
        Tüm istasyonlarınız tek ekranda. Gün sınırı Türkiye saatiyle gece yarısıdır — Gün Sonu Mutabakatı ile aynı
        tanım.
      </p>

      <div className="toolbar">
        <label htmlFor="pf-from" style={{ margin: 0 }}>
          Başlangıç
        </label>
        <input id="pf-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 170 }} />
        <label htmlFor="pf-to" style={{ margin: 0 }}>
          Bitiş
        </label>
        <input id="pf-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 170 }} />
        <div className="spacer" />
        <a href={`/api/portfolio/export.csv?from=${from}&to=${to}`}>
          <button type="button">CSV İndir</button>
        </a>
      </div>

      <div className="grid stats-grid">
        <Stat
          label="Toplam ciro"
          value={t ? formatCurrency(t.revenue) : "..."}
          caption={t ? `${t.transactionCount} işlem · ${formatCurrency(t.discount)} indirim` : ""}
          tone="neutral"
          icon={<WalletIcon />}
        />
        <Stat
          label="Toplam satış"
          value={t ? formatLiters(t.liters) : "..."}
          caption={t ? `${t.activeStationCount} / ${t.stationCount} istasyon aktif` : ""}
          tone="neutral"
          icon={<FuelIcon />}
        />
        <Stat
          label="Kümülatif sapma"
          value={t ? `${t.varianceLiters > 0 ? "+" : ""}${formatLiters(t.varianceLiters)}` : "..."}
          caption="Ölçüm yapılan istasyonların toplamı"
          tone={t && t.varianceLiters < 0 ? "bad" : "ok"}
          icon={t && t.varianceLiters < 0 ? <AlertIcon /> : <CheckCircleIcon />}
        />
        <Stat
          label="Müdahale bekleyen"
          value={t ? String(t.criticalAlarms + t.openSupportRequests) : "..."}
          caption={t ? `${t.criticalAlarms} kritik alarm · ${t.openSupportRequests} destek talebi` : ""}
          tone={t && t.criticalAlarms + t.openSupportRequests > 0 ? "bad" : "ok"}
          icon={t && t.criticalAlarms + t.openSupportRequests > 0 ? <AlertIcon /> : <CheckCircleIcon />}
        />
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>İstasyon</th>
                <th>İşlem</th>
                <th>Ciro</th>
                <th>Litre</th>
                <th>Sapma</th>
                <th>Alarm</th>
                <th>Destek</th>
                <th>Son senkron</th>
              </tr>
            </thead>
            <tbody>
              {(report?.stations ?? []).map((s) => (
                <tr key={s.stationId}>
                  <td>
                    <strong>{s.stationName}</strong>
                    <div className="hint-text">
                      <code>{s.stationCode ?? "—"}</code>
                      {s.active === 0 && " · pasif"}
                    </div>
                  </td>
                  <td>{s.transactionCount}</td>
                  <td>
                    <strong>{formatCurrency(s.revenue)}</strong>
                    {s.discount > 0 && <div className="hint-text">−{formatCurrency(s.discount)} indirim</div>}
                  </td>
                  <td>{formatLiters(s.liters)}</td>
                  <td>
                    {s.varianceLiters === null ? (
                      // Olcum yoklugu ile "olctuk, fark yok" ayni sey degil.
                      <span className="hint-text">ölçüm yok</span>
                    ) : (
                      <span className={`badge ${s.varianceLiters < 0 ? "critical" : "resolved"}`}>
                        {s.varianceLiters > 0 ? "+" : ""}
                        {formatLiters(s.varianceLiters)}
                      </span>
                    )}
                  </td>
                  <td>
                    {s.activeAlarms === 0 ? (
                      <span className="hint-text">—</span>
                    ) : (
                      <span className={`badge ${s.criticalAlarms > 0 ? "critical" : "warning"}`}>
                        {s.activeAlarms}
                        {s.criticalAlarms > 0 && ` (${s.criticalAlarms} kritik)`}
                      </span>
                    )}
                  </td>
                  <td>
                    {s.openSupportRequests > 0 ? (
                      <span className="badge critical">{s.openSupportRequests}</span>
                    ) : (
                      <span className="hint-text">—</span>
                    )}
                  </td>
                  <td className="hint-text">{s.lastSyncedAt ? formatDateTime(s.lastSyncedAt) : "—"}</td>
                </tr>
              ))}
              {report !== null && report.stations.length === 0 && (
                <tr>
                  <td colSpan={8} className="hint-text">
                    Henüz istasyon yok.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  caption,
  tone,
  icon,
}: {
  label: string;
  value: string;
  caption: string;
  tone: "ok" | "bad" | "neutral";
  icon: React.ReactNode;
}) {
  const palette = {
    ok: { background: "rgba(34,197,94,0.15)", color: "#4ade80" },
    bad: { background: "rgba(248,113,113,0.15)", color: "#f87171" },
    neutral: { background: "rgba(58,160,255,0.15)", color: "var(--accent)" },
  }[tone];

  return (
    <div className="card stat dash-stat">
      <div className="stat-icon" style={palette}>
        {icon}
      </div>
      <div className="stat-body">
        <span className="label">{label}</span>
        <span className="value" style={tone === "bad" ? { color: "#f87171" } : undefined}>
          {value}
        </span>
        <span className="stat-caption">{caption}</span>
      </div>
    </div>
  );
}
