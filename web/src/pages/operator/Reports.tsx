import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { FUEL_LABEL, PAYMENT_METHOD_LABEL, formatCurrency, formatDateTime } from "../../shared/format";
import type { ReconciliationRecord, SupplierDeliveryVarianceRow, SupplierSummaryRow, VarianceSummaryRow } from "../../shared/types";

/**
 * Rapor merkezi.
 *
 * Raporlar daha once sisteme dagilmisti: ciro burada, tedarikci ozeti stok sayfasinda,
 * sapma baska sayfada, gun sonu bir baskasinda. "Gecen ay ne oldu?" sorusunu cevaplamak
 * icin dort ayri sayfa gezmek gerekiyordu. Hepsi burada, TEK bir tarih araligi altinda
 * toplandi - sekmeler arasi gecis yapinca secilen aralik korunur, boylece ayni donemin
 * farkli yuzlerine bakmak icin filtreyi bastan kurmak gerekmez.
 */

interface SummaryResponse {
  totals: {
    transactionCount: number;
    totalRevenue: number;
    totalDiscount: number;
    totalLiters: number;
    completedCount: number;
    cancelledCount: number;
    failedCount: number;
  };
  byFuelType: Array<{
    fuelType: string;
    count: number;
    revenue: number;
    discount: number;
    grossRevenue: number;
    liters: number;
    avgCostPerLiter: number | null;
    estimatedGrossProfit: number | null;
  }>;
  byDay: Array<{ day: string; count: number; revenue: number }>;
  byPump: Array<{ pumpNumber: number; count: number; revenue: number; liters: number }>;
  byPaymentMethod: Array<{ paymentMethod: string; count: number; revenue: number }>;
  byHour: Array<{ hour: number; count: number; revenue: number }>;
}

interface RefundsResponse {
  totals: { refundCount: number; refundedAmount: number };
  byDay: Array<{ day: string; count: number; amount: number }>;
  byMethod: Array<{ paymentMethod: string; count: number; amount: number }>;
  recent: Array<{
    id: number;
    transactionId: number;
    amount: number;
    reason: string;
    paymentMethod: string;
    createdAt: string;
    plate: string;
    username: string | null;
  }>;
}

type Tab = "sales" | "refunds" | "dayEnd" | "stock";

const TABS: { id: Tab; label: string }[] = [
  { id: "sales", label: "Satış" },
  { id: "refunds", label: "İade" },
  { id: "dayEnd", label: "Gün Sonu" },
  { id: "stock", label: "Yakıt ve Tedarik" },
];

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function formatDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short" }).format(d);
}

function pct(part: number, total: number): string {
  if (total <= 0) return "%0";
  return `%${((part / total) * 100).toFixed(1)}`;
}

/** Aralik disina tasmayan, gunluk cubuk grafigi icin tam gun listesi. */
function fillDays(byDay: Array<{ day: string; count: number; revenue: number }>, from: string, to: string) {
  const byDate = new Map(byDay.map((d) => [d.day, d]));
  const result: Array<{ day: string; count: number; revenue: number }> = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  // Cok uzun araliklarda cubuklar okunamaz hale gelir; grafik yerine tablo daha
  // dogru olurdu - bu yuzden 120 gunle sinirlaniyor.
  for (let d = start; d <= end && result.length < 120; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    result.push(byDate.get(key) ?? { day: key, count: 0, revenue: 0 });
  }
  return result;
}

/** fillDays'teki AYNI tarih listeleme mantigi, ama sadece gun anahtarlari (deger tasimaz). */
function enumerateDays(from: string, to: string): string[] {
  const result: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = start; d <= end && result.length < 120; d.setUTCDate(d.getUTCDate() + 1)) {
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

interface FuelTrendRow {
  day: string;
  fuelType: string;
  count: number;
  revenue: number;
  liters: number;
}

const FUEL_TREND_COLOR: Record<string, string> = { benzin: "#22c55e", motorin: "#3aa0ff", lpg: "#f59e0b" };

/** Yakit turu bazinda zaman serisi - "motorin satisi son 30 gunde nasil gitti" sorusuna cevap. */
function FuelTypeTrendChart({ range, from, to }: { range: string; from: string; to: string }) {
  const [rows, setRows] = useState<FuelTrendRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    api.get<{ rows: FuelTrendRow[] }>(`/api/reports/fuel-type-trend?${range}`).then((res) => setRows(res.rows));
  }, [range]);

  if (!rows) {
    return (
      <div className="card">
        <h3>Yakıt Türüne Göre Trend</h3>
        <p className="hint-text">Yükleniyor...</p>
      </div>
    );
  }

  const days = enumerateDays(from, to);
  const fuelTypes = Array.from(new Set(rows.map((r) => r.fuelType))).sort();

  if (days.length < 2 || fuelTypes.length === 0) {
    return (
      <div className="card">
        <h3>Yakıt Türüne Göre Trend</h3>
        <p className="hint-text">Grafik için yeterli veri yok (en az 2 günlük satış gerekiyor).</p>
      </div>
    );
  }

  const byKey = new Map(rows.map((r) => [`${r.day}|${r.fuelType}`, r]));
  const series = fuelTypes.map((fuelType) => ({
    fuelType,
    points: days.map((day) => byKey.get(`${day}|${fuelType}`)?.liters ?? 0),
  }));

  const width = 600;
  const height = 160;
  const pad = 10;
  const maxVal = Math.max(1, ...series.flatMap((s) => s.points));
  const stepX = (width - pad * 2) / Math.max(days.length - 1, 1);
  const toPoints = (points: number[]) =>
    points.map((v, i) => `${pad + i * stepX},${height - pad - (v / maxVal) * (height - pad * 2)}`).join(" ");

  return (
    <div className="card">
      <div className="toolbar" style={{ marginBottom: "0.4rem" }}>
        <h3 style={{ margin: 0 }}>Yakıt Türüne Göre Trend</h3>
        <div className="spacer" />
        {fuelTypes.map((ft) => (
          <span key={ft} className="hint-text" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", marginLeft: "0.75rem" }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: FUEL_TREND_COLOR[ft] ?? "var(--text-dim)", display: "inline-block" }} />
            {FUEL_LABEL[ft as keyof typeof FUEL_LABEL] ?? ft}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "160px", display: "block" }} preserveAspectRatio="none">
        {series.map((s) => (
          <polyline key={s.fuelType} points={toPoints(s.points)} fill="none" stroke={FUEL_TREND_COLOR[s.fuelType] ?? "var(--text-dim)"} strokeWidth="2" />
        ))}
      </svg>
      <div className="toolbar hint-text" style={{ marginTop: "0.4rem" }}>
        <span>{formatDayLabel(days[0]!)}</span>
        <div className="spacer" />
        <span>{formatDayLabel(days[days.length - 1]!)}</span>
      </div>
      <p className="hint-text" style={{ marginTop: "0.4rem", marginBottom: 0 }}>Dikey eksen: günlük satılan litre.</p>
    </div>
  );
}

interface PeriodComparisonResponse {
  current: { from: string; to: string; revenue: number; liters: number; transactionCount: number; grossProfit: number; grossMarginPct: number | null };
  previous: { from: string; to: string; revenue: number; liters: number; transactionCount: number; grossProfit: number; grossMarginPct: number | null };
  changePct: { revenue: number | null; liters: number | null; transactionCount: number | null; grossProfit: number | null };
}

type ComparisonPreset = "month" | "year";

/** YYYY-MM-DD bicimine cevirir (Date.toISOString().slice(0,10) ile ayni). */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Bu ay/gecen ay ya da bu yil/gecen yil icin dort tarihi (guncel baslangic/bitis, onceki baslangic/bitis) hesaplar. */
function comparisonRangeFor(preset: ComparisonPreset): { currentFrom: string; currentTo: string; previousFrom: string; previousTo: string } {
  const now = new Date();
  if (preset === "month") {
    const currentFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const currentTo = now;
    const previousFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const previousTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return { currentFrom: isoDate(currentFrom), currentTo: isoDate(currentTo), previousFrom: isoDate(previousFrom), previousTo: isoDate(previousTo) };
  }
  const currentFrom = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const currentTo = now;
  const previousFrom = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
  const previousTo = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
  return { currentFrom: isoDate(currentFrom), currentTo: isoDate(currentTo), previousFrom: isoDate(previousFrom), previousTo: isoDate(previousTo) };
}

function changeBadge(pct: number | null) {
  if (pct === null) return <span className="hint-text">-</span>;
  const color = pct > 0 ? "var(--accent-2)" : pct < 0 ? "var(--danger)" : undefined;
  const sign = pct > 0 ? "+" : "";
  return <span style={{ color, fontWeight: 600 }}>{sign}{pct.toFixed(1)}%</span>;
}

/** Donemsel karsilastirma: bu ay/gecen ay ya da bu yil/gecen yil - ciro/litre/islem/kar karsilastirmasi. */
function PeriodComparisonCard({ stationId }: { stationId: number }) {
  const [preset, setPreset] = useState<ComparisonPreset>("month");
  const [data, setData] = useState<PeriodComparisonResponse | null>(null);

  useEffect(() => {
    setData(null);
    const r = comparisonRangeFor(preset);
    const qs = `currentFrom=${r.currentFrom}&currentTo=${r.currentTo}&previousFrom=${r.previousFrom}&previousTo=${r.previousTo}`;
    api.get<PeriodComparisonResponse>(`/api/reports/period-comparison?${qs}`).then(setData);
  }, [preset, stationId]);

  return (
    <div className="card">
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>Dönemsel Karşılaştırma</h3>
        <div className="spacer" />
        <div className="segmented" role="group" aria-label="Karşılaştırma dönemi">
          <button type="button" className={preset === "month" ? "active" : ""} aria-pressed={preset === "month"} onClick={() => setPreset("month")}>
            Bu Ay / Geçen Ay
          </button>
          <button type="button" className={preset === "year" ? "active" : ""} aria-pressed={preset === "year"} onClick={() => setPreset("year")}>
            Bu Yıl / Geçen Yıl
          </button>
        </div>
      </div>
      {!data ? (
        <p className="hint-text">Yükleniyor...</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Metrik</th>
                <th className="numeric">Güncel Dönem</th>
                <th className="numeric">Önceki Dönem</th>
                <th className="numeric">Değişim</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Ciro</td>
                <td className="numeric">{formatCurrency(data.current.revenue)}</td>
                <td className="numeric">{formatCurrency(data.previous.revenue)}</td>
                <td className="numeric">{changeBadge(data.changePct.revenue)}</td>
              </tr>
              <tr>
                <td>Litre</td>
                <td className="numeric">{data.current.liters.toFixed(1)} L</td>
                <td className="numeric">{data.previous.liters.toFixed(1)} L</td>
                <td className="numeric">{changeBadge(data.changePct.liters)}</td>
              </tr>
              <tr>
                <td>İşlem Sayısı</td>
                <td className="numeric">{data.current.transactionCount}</td>
                <td className="numeric">{data.previous.transactionCount}</td>
                <td className="numeric">{changeBadge(data.changePct.transactionCount)}</td>
              </tr>
              <tr>
                <td>Brüt Kâr</td>
                <td className="numeric">{formatCurrency(data.current.grossProfit)}</td>
                <td className="numeric">{formatCurrency(data.previous.grossProfit)}</td>
                <td className="numeric">{changeBadge(data.changePct.grossProfit)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Reports() {
  const stationId = useEffectiveStationId();
  const [tab, setTab] = useState<Tab>("sales");
  const [from, setFrom] = useState(isoDaysAgo(29));
  const [to, setTo] = useState(isoDaysAgo(0));

  const range = `from=${from}&to=${to}`;

  return (
    <div>
      <h2>Raporlama</h2>

      <div className="report-controls">
        <div className="segmented" role="group" aria-label="Rapor türü">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? "active" : ""}
              aria-pressed={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <RangePicker from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
      </div>

      {stationId === null ? (
        <p className="hint-text">İstasyon seçilmedi.</p>
      ) : (
        <>
          {tab === "sales" && <SalesReport range={range} from={from} to={to} stationId={stationId} />}
          {tab === "refunds" && <RefundsReport range={range} stationId={stationId} />}
          {tab === "dayEnd" && <DayEndReport stationId={stationId} />}
          {tab === "stock" && <StockReport range={range} stationId={stationId} />}
        </>
      )}
    </div>
  );
}

/** Tarih araligi + sik kullanilan donemler icin kisayollar. */
function RangePicker({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const presets: { label: string; days: number }[] = [
    { label: "7 gün", days: 6 },
    { label: "30 gün", days: 29 },
    { label: "90 gün", days: 89 },
  ];
  return (
    <div className="report-range">
      {presets.map((p) => (
        <button key={p.days} type="button" className="ghost btn-sm" onClick={() => onChange(isoDaysAgo(p.days), isoDaysAgo(0))}>
          {p.label}
        </button>
      ))}
      <label htmlFor="rep-range-from" style={{ margin: 0 }}>
        Başlangıç
      </label>
      <input id="rep-range-from" type="date" value={from} max={to} onChange={(e) => onChange(e.target.value, to)} />
      <label htmlFor="rep-range-to" style={{ margin: 0 }}>
        Bitiş
      </label>
      <input id="rep-range-to" type="date" value={to} min={from} onChange={(e) => onChange(from, e.target.value)} />
    </div>
  );
}

function SalesReport({ range, from, to, stationId }: { range: string; from: string; to: string; stationId: number }) {
  const [data, setData] = useState<SummaryResponse | null>(null);

  useEffect(() => {
    setData(null);
    api.get<SummaryResponse>(`/api/reports/summary?${range}`).then(setData);
  }, [range, stationId]);

  if (!data) return <p className="hint-text">Yükleniyor...</p>;

  const maxPumpRevenue = Math.max(1, ...data.byPump.map((d) => d.revenue));
  const avgTicket = data.totals.completedCount > 0 ? data.totals.totalRevenue / data.totals.completedCount : 0;
  const days = fillDays(data.byDay, from, to);
  const maxDayRevenue = Math.max(1, ...days.map((d) => d.revenue));
  const avgDayRevenue = days.length > 0 ? days.reduce((sum, d) => sum + d.revenue, 0) / days.length : 0;
  const bestDay = days.reduce<(typeof days)[number] | null>((best, d) => (!best || d.revenue > best.revenue ? d : best), null);
  const maxHourCount = Math.max(1, ...data.byHour.map((h) => h.count));

  return (
    <>
      <div className="grid cols-5">
        <div className="card stat">
          <span className="label">Toplam Ciro</span>
          <span className="value">{formatCurrency(data.totals.totalRevenue)}</span>
          <span className="hint-text">Müşteriden tahsil edilen gerçek tutar (indirim düşülmüş)</span>
        </div>
        <div className="card stat">
          <span className="label">Toplam İndirim</span>
          <span className="value" style={{ color: "var(--warning)" }}>{formatCurrency(data.totals.totalDiscount)}</span>
          <span className="hint-text">Kampanya kodu + puan kullanımı</span>
        </div>
        <div className="card stat">
          <span className="label">Toplam Litre</span>
          <span className="value">{data.totals.totalLiters.toFixed(1)} L</span>
        </div>
        <div className="card stat">
          <span className="label">Ortalama İşlem Tutarı</span>
          <span className="value">{formatCurrency(avgTicket)}</span>
        </div>
        <div className="card stat">
          <span className="label">Tamamlanan / İptal / Başarısız</span>
          <span className="value" style={{ fontSize: "var(--fs-lg)" }}>
            {data.totals.completedCount} / {data.totals.cancelledCount} / {data.totals.failedCount}
          </span>
        </div>
      </div>

      <PeriodComparisonCard stationId={stationId} />

      <div className="card">
        <h3>Yakıt Tipine Göre</h3>
          <p className="hint-text">
            Tahmini Kar: satılan litre × tankın güncel ortalama alış maliyeti kullanılarak hesaplanır (satış anındaki
            gerçek maliyet değil, yaklaşık bir değerdir). Bu yakıt tipi için hiç maliyet girilmemişse "-" gösterilir.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Yakıt</th>
                  <th className="numeric">İşlem</th>
                  <th className="numeric">Litre</th>
                  <th className="numeric">Ort. Fiyat</th>
                  <th className="numeric">İndirim</th>
                  <th className="numeric">Ciro</th>
                  <th className="numeric">Tahmini Kar</th>
                  <th className="numeric">Pay</th>
                </tr>
              </thead>
              <tbody>
                {data.byFuelType.map((f) => (
                  <tr key={f.fuelType}>
                    <td><span className={`fuel-dot ${f.fuelType}`} />{FUEL_LABEL[f.fuelType] ?? f.fuelType}</td>
                    <td className="numeric">{f.count}</td>
                    <td className="numeric">{f.liters.toFixed(1)} L</td>
                    <td className="numeric">{formatCurrency(f.liters > 0 ? f.grossRevenue / f.liters : 0)}</td>
                    <td className="numeric">{f.discount > 0 ? formatCurrency(f.discount) : "-"}</td>
                    <td className="numeric">{formatCurrency(f.revenue)}</td>
                    <td className="numeric" style={{ color: f.estimatedGrossProfit !== null && f.estimatedGrossProfit < 0 ? "var(--danger)" : undefined }}>
                      {f.estimatedGrossProfit !== null ? formatCurrency(f.estimatedGrossProfit) : "-"}
                    </td>
                    <td className="numeric"><span className="share-pill">{pct(f.revenue, data.totals.totalRevenue)}</span></td>
                  </tr>
                ))}
                {data.byFuelType.length === 0 && <tr><td colSpan={8} className="hint-text">Bu aralıkta satış yok.</td></tr>}
                {data.byFuelType.length > 0 && (
                  <tr className="table-total">
                    <td>Toplam</td>
                    <td className="numeric">{data.byFuelType.reduce((s, f) => s + f.count, 0)}</td>
                    <td className="numeric">{data.byFuelType.reduce((s, f) => s + f.liters, 0).toFixed(1)} L</td>
                    <td className="hint-text-cell numeric">-</td>
                    <td className="numeric">{formatCurrency(data.byFuelType.reduce((s, f) => s + f.discount, 0))}</td>
                    <td className="numeric">{formatCurrency(data.byFuelType.reduce((s, f) => s + f.revenue, 0))}</td>
                    <td className="numeric">
                      {data.byFuelType.some((f) => f.estimatedGrossProfit !== null)
                        ? formatCurrency(data.byFuelType.reduce((s, f) => s + (f.estimatedGrossProfit ?? 0), 0))
                        : "-"}
                    </td>
                    <td className="numeric">%100.0</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Pompa Bazında Performans</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pompa</th>
                  <th className="numeric">İşlem</th>
                  <th className="numeric">Litre</th>
                  <th className="numeric">Ciro</th>
                  <th>Pay</th>
                </tr>
              </thead>
              <tbody>
                {data.byPump.map((p) => (
                  <tr key={p.pumpNumber}>
                    <td>Pompa {p.pumpNumber}</td>
                    <td className="numeric">{p.count}</td>
                    <td className="numeric">{p.liters.toFixed(1)} L</td>
                    <td className="numeric">{formatCurrency(p.revenue)}</td>
                    <td className="report-bar-cell">
                      <div className="report-bar-track">
                        <div className="report-bar-fill" style={{ width: `${(p.revenue / maxPumpRevenue) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
                {data.byPump.length === 0 && <tr><td colSpan={5} className="hint-text">Pompa tanımlı değil.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h3>Ödeme Yöntemi</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Yöntem</th><th className="numeric">İşlem</th><th className="numeric">Ciro</th><th className="numeric">Pay</th></tr>
              </thead>
              <tbody>
                {data.byPaymentMethod.map((m) => (
                  <tr key={m.paymentMethod}>
                    <td>{PAYMENT_METHOD_LABEL[m.paymentMethod] ?? m.paymentMethod}</td>
                    <td className="numeric">{m.count}</td>
                    <td className="numeric">{formatCurrency(m.revenue)}</td>
                    <td className="numeric"><span className="share-pill">{pct(m.revenue, data.totals.totalRevenue)}</span></td>
                  </tr>
                ))}
                {data.byPaymentMethod.length === 0 && <tr><td colSpan={4} className="hint-text">Bu aralıkta satış yok.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <h3 style={{ margin: 0 }}>Günlük Ciro</h3>
          <div className="spacer" />
          {bestDay && bestDay.revenue > 0 && (
            <span className="hint-text">En yüksek: {formatDayLabel(bestDay.day)} ({formatCurrency(bestDay.revenue)})</span>
          )}
          <span className="hint-text">Günlük ortalama: {formatCurrency(avgDayRevenue)}</span>
        </div>
        <div className="report-day-chart">
          {days.map((d) => (
            <div key={d.day} className="report-day-bar-wrap" title={`${formatDayLabel(d.day)}: ${formatCurrency(d.revenue)} (${d.count} işlem)`}>
              <div className="report-day-bar" style={{ height: `${Math.max((d.revenue / maxDayRevenue) * 100, 1.5)}%` }} />
            </div>
          ))}
        </div>
        {days.length > 0 && (
          <div className="report-axis">
            <span className="hint-text">{formatDayLabel(days[0]!.day)}</span>
            <span className="hint-text">{formatDayLabel(days[days.length - 1]!.day)}</span>
          </div>
        )}
      </div>

      <FuelTypeTrendChart range={range} from={from} to={to} />

      <div className="card">
        <h3>Yoğun Saatler</h3>
          <p className="hint-text">Vardiya planlaması için: günün hangi saatlerinde kaç dolum yapılıyor.</p>
          <div className="report-day-chart">
            {Array.from({ length: 24 }, (_, h) => data.byHour.find((x) => x.hour === h) ?? { hour: h, count: 0, revenue: 0 }).map((h) => (
              <div key={h.hour} className="report-day-bar-wrap" title={`${String(h.hour).padStart(2, "0")}:00 · ${h.count} işlem · ${formatCurrency(h.revenue)}`}>
                <div className="report-day-bar" style={{ height: `${Math.max((h.count / maxHourCount) * 100, 1.5)}%` }} />
              </div>
            ))}
          </div>
          <div className="report-axis">
            <span className="hint-text">00:00</span>
            <span className="hint-text">23:00</span>
          </div>
        </div>

    </>
  );
}

function RefundsReport({ range, stationId }: { range: string; stationId: number }) {
  const [data, setData] = useState<RefundsResponse | null>(null);

  useEffect(() => {
    setData(null);
    api.get<RefundsResponse>(`/api/reports/refunds?${range}`).then(setData);
  }, [range, stationId]);

  if (!data) return <p className="hint-text">Yükleniyor...</p>;

  return (
    <>
      <div className="grid cols-3">
        <div className="card stat">
          <span className="label">İade Edilen Tutar</span>
          <span className="value" style={{ color: "var(--warning)" }}>{formatCurrency(data.totals.refundedAmount)}</span>
          <span className="hint-text">İadenin yapıldığı güne yazılır, satışın gününe değil</span>
        </div>
        <div className="card stat">
          <span className="label">İade Sayısı</span>
          <span className="value">{data.totals.refundCount}</span>
        </div>
        <div className="card stat">
          <span className="label">Ortalama İade</span>
          <span className="value">
            {formatCurrency(data.totals.refundCount > 0 ? data.totals.refundedAmount / data.totals.refundCount : 0)}
          </span>
        </div>
      </div>

      <div className="card">
        <h3>İadenin Gittiği Yer</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Ödeme yöntemi</th><th className="numeric">Adet</th><th className="numeric">Tutar</th></tr>
            </thead>
            <tbody>
              {data.byMethod.map((m) => (
                <tr key={m.paymentMethod}>
                  <td>{PAYMENT_METHOD_LABEL[m.paymentMethod] ?? m.paymentMethod}</td>
                  <td className="numeric">{m.count}</td>
                  <td className="numeric">{formatCurrency(m.amount)}</td>
                </tr>
              ))}
              {data.byMethod.length === 0 && <tr><td colSpan={3} className="hint-text">Bu aralıkta iade yok.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>İade Kayıtları</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Tarih</th><th>İşlem</th><th>Plaka</th><th className="numeric">Tutar</th><th>Gerekçe</th><th>Yapan</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r) => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td>#{r.transactionId}</td>
                  <td>{r.plate}</td>
                  <td className="numeric">{formatCurrency(r.amount)}</td>
                  <td>{r.reason}</td>
                  <td>{r.username ?? "-"}</td>
                </tr>
              ))}
              {data.recent.length === 0 && <tr><td colSpan={6} className="hint-text">Bu aralıkta iade yok.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function DayEndReport({ stationId }: { stationId: number }) {
  const [records, setRecords] = useState<ReconciliationRecord[] | null>(null);

  useEffect(() => {
    setRecords(null);
    api.get<{ reconciliations: ReconciliationRecord[] }>("/api/reconciliation?limit=90").then((r) => setRecords(r.reconciliations));
  }, [stationId]);

  if (!records) return <p className="hint-text">Yükleniyor...</p>;

  const totalDiff = records.reduce((s, r) => s + r.difference, 0);

  return (
    <div className="card">
      <div className="toolbar">
        <h3 style={{ margin: 0 }}>Kapatılan Günler</h3>
        <div className="spacer" />
        <span className="hint-text">Toplam fark: {formatCurrency(totalDiff)}</span>
        <a href="/api/reconciliation/export.csv"><button className="ghost btn-sm">CSV indir</button></a>
      </div>
      <p className="hint-text">
        Gün sonu mutabakatı, kasadaki gerçek tutar ile sistemin beklediği tutarı karşılaştırır. Süregelen bir fark,
        tek bir günün hatası değil bir düzen sorunudur; bu liste onu görünür kılar.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>İş günü</th>
              <th className="numeric">Beklenen</th>
              <th className="numeric">Sayılan</th>
              <th className="numeric">Fark</th>
              <th className="numeric">Askıda</th>
              <th>Kapatan</th>
              <th>Not</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>{r.businessDate}</td>
                <td className="numeric">{formatCurrency(r.expectedTotal)}</td>
                <td className="numeric">{formatCurrency(r.declaredTotal)}</td>
                <td className="numeric" style={{ color: Math.abs(r.difference) > 0.005 ? "var(--danger)" : undefined }}>
                  {formatCurrency(r.difference)}
                </td>
                <td className="numeric">{r.pendingCount}</td>
                <td>{r.closedBy ?? "-"}</td>
                <td>{r.note ?? "-"}</td>
              </tr>
            ))}
            {records.length === 0 && <tr><td colSpan={7} className="hint-text">Henüz kapatılmış gün yok.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StockReport({ range, stationId }: { range: string; stationId: number }) {
  const [suppliers, setSuppliers] = useState<SupplierSummaryRow[] | null>(null);
  const [variance, setVariance] = useState<VarianceSummaryRow[] | null>(null);
  const [deliveryVariance, setDeliveryVariance] = useState<SupplierDeliveryVarianceRow[] | null>(null);

  useEffect(() => {
    api.get<{ suppliers: SupplierSummaryRow[] }>(`/api/fuel-stock/suppliers/summary?${range}`).then((r) => setSuppliers(r.suppliers));
    // Sapma ozeti kendi ucunda degil, olcum listesinin yaninda donuyor; burada yalnizca
    // ozet kismi kullaniliyor (limit=1 ile gereksiz satir cekilmesin diye).
    api.get<{ summary: VarianceSummaryRow[] }>("/api/fuel-stock/readings?limit=1").then((r) => setVariance(r.summary));
    api
      .get<{ suppliers: SupplierDeliveryVarianceRow[] }>(`/api/fuel-stock/delivery-variance/suppliers?${range}`)
      .then((r) => setDeliveryVariance(r.suppliers));
  }, [range, stationId]);

  return (
    <>
      <div className="card">
        <h3>Tedarikçi Özeti</h3>
        <p className="hint-text">Hangi tedarikçiden ne kadar alındı ve ortalama alış maliyeti ne oldu.</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Tedarikçi</th><th>Yakıt</th><th className="numeric">Teslimat</th>
                <th className="numeric">Litre</th><th className="numeric">Ort. Maliyet</th><th>Son teslimat</th>
              </tr>
            </thead>
            <tbody>
              {(suppliers ?? []).map((s, i) => (
                <tr key={`${s.supplier}-${s.fuelType}-${i}`}>
                  <td>{s.supplier}</td>
                  <td>{FUEL_LABEL[s.fuelType] ?? s.fuelType}</td>
                  <td className="numeric">{s.deliveryCount}</td>
                  <td className="numeric">{s.totalLiters.toFixed(1)} L</td>
                  <td className="numeric">{s.avgUnitCost !== null ? formatCurrency(s.avgUnitCost) : "-"}</td>
                  <td>{s.lastDeliveryAt ? formatDateTime(s.lastDeliveryAt) : "-"}</td>
                </tr>
              ))}
              {suppliers?.length === 0 && <tr><td colSpan={6} className="hint-text">Tedarikçi bilgisi girilmiş teslimat yok.</td></tr>}
              {suppliers === null && <tr><td colSpan={6} className="hint-text">Yükleniyor...</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Teslimat Kabul Farkı</h3>
        <p className="hint-text">
          İrsaliyede yazan ile tanka fiilen giren miktar arasındaki fark. Bir tedarikçide süregelen eksi fark,
          tek bir tankerin değil bir düzenin işareti.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Tedarikçi</th><th className="numeric">Teslimat</th><th className="numeric">Ölçülen</th>
                <th className="numeric">İrsaliye</th><th className="numeric">Kabul</th>
                <th className="numeric">Fark</th><th className="numeric">%</th>
              </tr>
            </thead>
            <tbody>
              {(deliveryVariance ?? []).map((s) => (
                <tr key={s.supplier}>
                  <td>{s.supplier}</td>
                  <td className="numeric">{s.deliveryCount}</td>
                  <td className="numeric">{s.measuredCount}</td>
                  <td className="numeric">{s.declaredLiters.toFixed(1)} L</td>
                  <td className="numeric">{s.acceptedLiters.toFixed(1)} L</td>
                  <td className="numeric" style={{ color: s.varianceLiters < 0 ? "var(--danger)" : undefined }}>
                    {s.varianceLiters.toFixed(1)} L
                  </td>
                  <td className="numeric">%{s.variancePct.toFixed(2)}</td>
                </tr>
              ))}
              {deliveryVariance?.length === 0 && <tr><td colSpan={7} className="hint-text">Bu aralıkta ölçülmüş teslimat yok.</td></tr>}
              {deliveryVariance === null && <tr><td colSpan={7} className="hint-text">Yükleniyor...</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {variance !== null && variance.length > 0 && (
        <div className="card">
          <h3>Yakıt Sapması</h3>
          <p className="hint-text">Fiziksel tank ölçümü ile kayıttaki miktar arasındaki fark - kaçak veya kayıp göstergesi.</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Yakıt</th><th className="numeric">Ölçüm</th><th className="numeric">Toplam sapma</th>
                  <th className="numeric">Net %</th><th>Son ölçüm</th>
                </tr>
              </thead>
              <tbody>
                {variance.map((v) => (
                  <tr key={v.fuelType}>
                    <td>{FUEL_LABEL[v.fuelType] ?? v.fuelType}</td>
                    <td className="numeric">{v.readingCount}</td>
                    <td className="numeric" style={{ color: v.totalVarianceLiters < 0 ? "var(--danger)" : undefined }}>
                      {v.totalVarianceLiters.toFixed(1)} L
                    </td>
                    <td className="numeric">%{v.netVariancePct.toFixed(2)}</td>
                    <td>{v.lastMeasuredAt ? formatDateTime(v.lastMeasuredAt) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
