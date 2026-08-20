import { db } from "../db/index.js";
import type { FuelType, StationRow, UserRow } from "../db/types.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { sendEmail } from "./notificationService.js";
import { logger } from "../utils/logger.js";

export type ReportEmailFrequency = "none" | "weekly" | "monthly";

const FREQUENCY_KEY = "report_email_frequency";
const LAST_SENT_KEY = "report_email_last_sent_at";

export function getReportEmailConfig(stationId: number): { frequency: ReportEmailFrequency; lastSentAt: string | null } {
  const raw = getSetting(stationId, FREQUENCY_KEY);
  const frequency: ReportEmailFrequency = raw === "weekly" || raw === "monthly" ? raw : "none";
  return { frequency, lastSentAt: getSetting(stationId, LAST_SENT_KEY) };
}

export function setReportEmailFrequency(stationId: number, frequency: ReportEmailFrequency, actor: UserRow): void {
  setSetting(stationId, FREQUENCY_KEY, frequency, actor);
}

function nextDueDate(frequency: "weekly" | "monthly", lastSentAt: string | null): Date {
  const base = lastSentAt ? new Date(lastSentAt) : new Date(0);
  const next = new Date(base);
  if (frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

interface PeriodSummary {
  transactionCount: number;
  revenue: number;
  discount: number;
  liters: number;
  byFuelType: { fuelType: FuelType; liters: number; revenue: number; estimatedGrossProfit: number | null }[];
}

function computePeriodSummary(stationId: number, fromIso: string, toIso: string): PeriodSummary {
  const totals = db
    .prepare<[number, string, string], { transactionCount: number; revenue: number; discount: number; liters: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as transactionCount,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN MAX(0, total_amount - discount_amount) ELSE 0 END), 0) as revenue,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN discount_amount ELSE 0 END), 0) as discount,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN dispensed_liters ELSE 0 END), 0) as liters
       FROM transactions WHERE station_id = ? AND created_at >= ? AND created_at < ?`
    )
    .get(stationId, fromIso, toIso)!;

  const byFuel = db
    .prepare<[number, string, string], { fuelType: FuelType; liters: number; revenue: number }>(
      `SELECT fuel_type as fuelType,
              COALESCE(SUM(dispensed_liters), 0) as liters,
              COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0) as revenue
       FROM transactions WHERE station_id = ? AND status = 'completed' AND created_at >= ? AND created_at < ?
       GROUP BY fuel_type`
    )
    .all(stationId, fromIso, toIso);

  const avgCosts = db
    .prepare<[number], { fuelType: FuelType; avgCost: number }>(
      `SELECT fuel_type as fuelType, average_cost_per_liter as avgCost FROM fuel_tanks WHERE station_id = ?`
    )
    .all(stationId);
  const avgCostByFuel = new Map(avgCosts.map((r) => [r.fuelType, r.avgCost]));

  return {
    ...totals,
    byFuelType: byFuel.map((f) => {
      const avgCost = avgCostByFuel.get(f.fuelType) ?? 0;
      return { ...f, estimatedGrossProfit: avgCost > 0 ? Math.round((f.revenue - avgCost * f.liters) * 100) / 100 : null };
    }),
  };
}

const FUEL_LABELS: Record<FuelType, string> = { benzin: "Benzin", motorin: "Motorin", lpg: "LPG" };

function formatCurrency(v: number): string {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(v);
}

function buildEmail(station: StationRow, frequency: "weekly" | "monthly", summary: PeriodSummary, fromDate: Date, toDate: Date) {
  const periodLabel = frequency === "weekly" ? "Haftalik" : "Aylik";
  const dateRange = `${fromDate.toLocaleDateString("tr-TR")} - ${toDate.toLocaleDateString("tr-TR")}`;
  const subject = `[${periodLabel} Ozet] ${station.name} (${dateRange})`;

  const fuelLines = summary.byFuelType
    .map(
      (f) =>
        `${FUEL_LABELS[f.fuelType] ?? f.fuelType}: ${f.liters.toFixed(1)} L, ciro ${formatCurrency(f.revenue)}` +
        (f.estimatedGrossProfit !== null ? `, tahmini kar ${formatCurrency(f.estimatedGrossProfit)}` : "")
    )
    .join("\n");

  const text = `${station.name} - ${periodLabel} Ozet Raporu (${dateRange})

Tamamlanan islem: ${summary.transactionCount}
Toplam ciro: ${formatCurrency(summary.revenue)}
Toplam indirim: ${formatCurrency(summary.discount)}
Toplam litre: ${summary.liters.toFixed(1)} L

Yakit tipine gore:
${fuelLines || "Bu donemde satis yok."}

Bu e-posta otomatik olarak gonderilmistir (Ayarlar > Otomatik Ozet Raporu).`;

  const html = `<h2>${station.name} - ${periodLabel} Ozet Raporu</h2>
<p>${dateRange}</p>
<ul>
  <li>Tamamlanan islem: <strong>${summary.transactionCount}</strong></li>
  <li>Toplam ciro: <strong>${formatCurrency(summary.revenue)}</strong></li>
  <li>Toplam indirim: <strong>${formatCurrency(summary.discount)}</strong></li>
  <li>Toplam litre: <strong>${summary.liters.toFixed(1)} L</strong></li>
</ul>
<h3>Yakit Tipine Gore</h3>
${
  summary.byFuelType.length > 0
    ? `<ul>${summary.byFuelType
        .map(
          (f) =>
            `<li>${FUEL_LABELS[f.fuelType] ?? f.fuelType}: ${f.liters.toFixed(1)} L, ciro ${formatCurrency(f.revenue)}${
              f.estimatedGrossProfit !== null ? `, tahmini kar ${formatCurrency(f.estimatedGrossProfit)}` : ""
            }</li>`
        )
        .join("")}</ul>`
    : "<p>Bu donemde satis yok.</p>"
}
<p style="color:#888;font-size:0.85em;">Bu e-posta otomatik olarak gonderilmistir (Ayarlar &gt; Otomatik Ozet Raporu).</p>`;

  return { subject, text, html };
}

/** Her istasyon icin, ayarlanan sikilik (haftalik/aylik) suresi dolmussa ozet raporu e-postasi gonderir. Sunucu baslangicinda ve periyodik olarak (bkz. index.ts) cagrilir. */
export async function maybeSendScheduledReportEmails(): Promise<void> {
  const stations = db.prepare<[], StationRow>("SELECT * FROM stations WHERE active = 1").all();

  for (const station of stations) {
    const { frequency, lastSentAt } = getReportEmailConfig(station.id);
    if (frequency === "none") continue;

    const dueAt = nextDueDate(frequency, lastSentAt);
    const now = new Date();
    if (now < dueAt) continue;

    const fromDate = lastSentAt ? new Date(lastSentAt) : new Date(dueAt.getTime() - (frequency === "weekly" ? 7 : 30) * 86400000);
    const summary = computePeriodSummary(station.id, fromDate.toISOString(), now.toISOString());

    const recipients = db
      .prepare<[number], UserRow>(
        `SELECT u.* FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.station_id = ? AND u.active = 1 AND r.name = 'admin' AND u.email IS NOT NULL AND trim(u.email) != ''`
      )
      .all(station.id);

    if (recipients.length === 0) {
      // Alici yoksa yine de son gonderim zamanini ilerletiyoruz - aksi halde e-posta
      // eklenene kadar her kontrolde ayni (biriken, gittikce buyuyen) donem icin
      // hesaplama tekrarlanir ve alici eklendigi an aninda cok uzun bir ozet gider.
      setSetting(station.id, LAST_SENT_KEY, now.toISOString(), null);
      continue;
    }

    const { subject, text, html } = buildEmail(station, frequency, summary, fromDate, now);
    await Promise.all(recipients.map((u) => sendEmail(u.email!, subject, text, html)));
    setSetting(station.id, LAST_SENT_KEY, now.toISOString(), null);
    logger.info({ stationId: station.id, frequency, recipients: recipients.length }, "Otomatik ozet raporu e-postasi gonderildi.");
  }
}
