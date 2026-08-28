import { db } from "../db/index.js";
import { BUSINESS_DAY_SQL_OFFSET, businessDateDaysAgo, businessDayExpr, currentBusinessDate } from "../utils/businessDay.js";
import { getLiveTotalsForDate, getRollupTotals, isDateRollupCovered, type RollupTotals } from "./rollupService.js";

/**
 * Konsolide (cok istasyonlu) rapor.
 *
 * Mevcut raporlama tek istasyona bakiyor; 40 istasyonu olan bir dagitici toplam
 * cirosunu gormek icin 40 istasyonu tek tek gezmek zorundaydi. Bu servis o soruyu
 * tek sorguda cevaplar.
 *
 * Tarih araligi mutabakatla AYNI is gunu tanimini kullanir (bkz. utils/businessDay.ts):
 * iki ekranin "bugun"u farkli anlamasi, ayni gun icin farkli rakamlar gostermeleri
 * demek olurdu.
 *
 * ISLEM-TUREVLI ALANLAR (transactionCount/revenue/discount/liters) IKI YOLDAN biri ile
 * gelir - bkz. rollupService.ts:
 *   - Rollup KAPSAM DAHILINDEYSE (isDateRollupCovered(from)): station_daily_rollups'tan
 *     okunur (hizli, veri buyudukce sabit sure) + "bugun" icin ayrica canli sorgu
 *     (rollup hicbir zaman bugunu icermez, bugun hala buyumektedir).
 *   - DEGILSE (rollup henuz hic calismadi, ya da `from` ilk backfill'den daha eski):
 *     eski korele alt sorgu yoluna duser - bu YOL DEGISMEDI, sadece artik YEDEK.
 * Boylece davranis hicbir zaman geriye gitmez (rollup eksikse eskisi gibi calisir),
 * yalnizca kapsam dahilindeyken hizlanir.
 */

export interface PortfolioStationRow {
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
  /** Secilen araliktaki kumulatif yakit sapmasi (eksi: kayip). Olcum yoksa null. */
  varianceLiters: number | null;
  lastSyncedAt: string | null;
}

export interface PortfolioTotals {
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
}

export interface PortfolioReport {
  from: string;
  to: string;
  stations: PortfolioStationRow[];
  totals: PortfolioTotals;
}

export interface PortfolioScope {
  /** null: kisit yok (platform yoneticisi). Sayi: yalnizca o dagitim sirketinin istasyonlari. */
  tenantId: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface StationShellRow {
  stationId: number;
  stationName: string;
  stationCode: string | null;
  active: number;
  activeAlarms: number;
  criticalAlarms: number;
  openSupportRequests: number;
  lastSyncedAt: string | null;
}

/**
 * Istasyon meta bilgisi + islem tablosuyla ILGISIZ olcumler (acik alarm, acik destek,
 * son senkron). Tarih araligina BAGLI DEGILDIR - hepsi "su anki durum". Hem hizli hem
 * yedek yolda AYNEN kullanilir; darbogaz burada degildi (kucuk tablolar).
 */
function getStationShells(scope: PortfolioScope): StationShellRow[] {
  const tenantFilter = scope.tenantId !== null ? "AND s.tenant_id = ?" : "";
  const params: number[] = scope.tenantId !== null ? [scope.tenantId] : [];
  return db
    .prepare<number[], StationShellRow>(
      `SELECT
         s.id AS stationId,
         s.name AS stationName,
         s.code AS stationCode,
         s.active AS active,
         (SELECT COUNT(*) FROM alarms a WHERE a.station_id = s.id AND a.status = 'active') AS activeAlarms,
         (SELECT COUNT(*) FROM alarms a WHERE a.station_id = s.id AND a.status = 'active' AND a.severity = 'critical') AS criticalAlarms,
         (SELECT COUNT(*) FROM support_requests sr WHERE sr.station_id = s.id AND sr.status = 'open') AS openSupportRequests,
         (SELECT ss.last_synced_at FROM station_sync_state ss WHERE ss.station_id = s.id) AS lastSyncedAt
       FROM stations s
       WHERE 1 = 1 ${tenantFilter}`
    )
    .all(...params);
}

/** Litre ve sapma ayri cekiliyor: ikisi de farkli tablolardan geliyor. Ikisi de TEK
 * sorgu, sonuc bellekte eslestiriliyor. Hem hizli hem yedek yolda AYNEN kullanilir. */
function getVarianceByStation(scope: PortfolioScope, from: string, to: string): Map<number, number> {
  const params: (string | number)[] = [from, to];
  if (scope.tenantId !== null) params.push(scope.tenantId);
  const rows = db
    .prepare<(string | number)[], { station_id: number; variance: number }>(
      `SELECT r.station_id, ROUND(SUM(r.variance_liters), 2) AS variance
       FROM fuel_tank_readings r
       JOIN stations s ON s.id = r.station_id
       WHERE date(r.measured_at, '${BUSINESS_DAY_SQL_OFFSET}') BETWEEN ? AND ?
         ${scope.tenantId !== null ? "AND s.tenant_id = ?" : ""}
       GROUP BY r.station_id`
    )
    .all(...params);
  return new Map(rows.map((r) => [r.station_id, r.variance]));
}

function buildTotals(stations: PortfolioStationRow[]): PortfolioTotals {
  return {
    stationCount: stations.length,
    activeStationCount: stations.filter((s) => s.active === 1).length,
    transactionCount: stations.reduce((n, s) => n + s.transactionCount, 0),
    revenue: round2(stations.reduce((n, s) => n + s.revenue, 0)),
    discount: round2(stations.reduce((n, s) => n + s.discount, 0)),
    liters: round2(stations.reduce((n, s) => n + s.liters, 0)),
    activeAlarms: stations.reduce((n, s) => n + s.activeAlarms, 0),
    criticalAlarms: stations.reduce((n, s) => n + s.criticalAlarms, 0),
    openSupportRequests: stations.reduce((n, s) => n + s.openSupportRequests, 0),
    varianceLiters: round2(stations.reduce((n, s) => n + (s.varianceLiters ?? 0), 0)),
  };
}

function sortStations(stations: PortfolioStationRow[]): PortfolioStationRow[] {
  return [...stations].sort((a, b) => b.revenue - a.revenue || a.stationName.localeCompare(b.stationName, "tr"));
}

/**
 * HIZLI YOL: rollup kapsam dahilinde oldugunda. Istasyon basina korele alt sorgu
 * YERINE onceden hesaplanmis toplamlari okur - veri buyudukce sure SABIT kalir.
 */
function getPortfolioReportFast(scope: PortfolioScope, from: string, to: string): PortfolioReport {
  const shells = getStationShells(scope);
  const varianceByStation = getVarianceByStation(scope, from, to);

  const today = currentBusinessDate();
  const yesterday = businessDateDaysAgo(1);
  // Rollup HICBIR ZAMAN bugunu icermez (hep buyumekte olan gun) - araligi bugunun
  // BIR ONCESINE kadar kirp. from > rollupTo ise (ör. aralik yalnizca bugun) rollup
  // sorgusu atlanir.
  const rollupTo = to < yesterday ? to : yesterday;
  const rollupTotals = from <= rollupTo ? getRollupTotals(scope.tenantId, from, rollupTo) : new Map<number, RollupTotals>();

  const includesToday = to >= today && today >= from;
  const todayTotals = includesToday ? getLiveTotalsForDate(scope.tenantId, today) : new Map<number, RollupTotals>();

  const stations: PortfolioStationRow[] = shells.map((shell) => {
    const r = rollupTotals.get(shell.stationId);
    const t = todayTotals.get(shell.stationId);
    return {
      ...shell,
      transactionCount: (r?.transactionCount ?? 0) + (t?.transactionCount ?? 0),
      revenue: round2((r?.revenue ?? 0) + (t?.revenue ?? 0)),
      discount: round2((r?.discount ?? 0) + (t?.discount ?? 0)),
      liters: round2((r?.liters ?? 0) + (t?.liters ?? 0)),
      varianceLiters: varianceByStation.get(shell.stationId) ?? null,
    };
  });

  const sorted = sortStations(stations);
  return { from, to, stations: sorted, totals: buildTotals(sorted) };
}

/**
 * YEDEK YOL: rollup kapsam disindaysa (henuz hic calismadi, ya da `from` ilk
 * backfill'den daha eski) buraya duselir. Istasyon basina korele alt sorgu - bu,
 * ozellik rollup eklenmeden ONCE tek yoldu ve DAVRANISI DEGISMEDI.
 */
function getPortfolioReportLive(scope: PortfolioScope, from: string, to: string): PortfolioReport {
  const tenantFilter = scope.tenantId !== null ? "AND s.tenant_id = ?" : "";
  // Parametre sirasi sorgudaki ? sirasiyla birebir: once tarih araliklari, sonra kiraci.
  const params: (string | number)[] = [from, to, from, to, from, to];
  if (scope.tenantId !== null) params.push(scope.tenantId);

  const rows = db
    .prepare<(string | number)[], PortfolioStationRow>(
      `SELECT
         s.id AS stationId,
         s.name AS stationName,
         s.code AS stationCode,
         s.active AS active,
         (SELECT COUNT(*) FROM transactions t
           WHERE t.station_id = s.id AND t.status = 'completed'
             AND ${businessDayExpr("t")} BETWEEN ? AND ?
         ) AS transactionCount,
         COALESCE((SELECT ROUND(SUM(MAX(0, t.total_amount - t.discount_amount)), 2) FROM transactions t
           WHERE t.station_id = s.id AND t.status = 'completed'
             AND ${businessDayExpr("t")} BETWEEN ? AND ?
         ), 0) AS revenue,
         COALESCE((SELECT ROUND(SUM(t.discount_amount), 2) FROM transactions t
           WHERE t.station_id = s.id AND t.status = 'completed'
             AND ${businessDayExpr("t")} BETWEEN ? AND ?
         ), 0) AS discount,
         0 AS liters,
         (SELECT COUNT(*) FROM alarms a WHERE a.station_id = s.id AND a.status = 'active') AS activeAlarms,
         (SELECT COUNT(*) FROM alarms a WHERE a.station_id = s.id AND a.status = 'active' AND a.severity = 'critical') AS criticalAlarms,
         (SELECT COUNT(*) FROM support_requests sr WHERE sr.station_id = s.id AND sr.status = 'open') AS openSupportRequests,
         NULL AS varianceLiters,
         (SELECT ss.last_synced_at FROM station_sync_state ss WHERE ss.station_id = s.id) AS lastSyncedAt
       FROM stations s
       WHERE 1 = 1 ${tenantFilter}
       ORDER BY revenue DESC, s.name ASC`
    )
    .all(...params);

  // Litre ayri cekiliyor: farkli sekilde grupluyor (korele alt sorgu degil) ve
  // yukaridaki sorguya eklemek okunurlugu bozardi.
  const literParams: (string | number)[] = [from, to];
  if (scope.tenantId !== null) literParams.push(scope.tenantId);
  const literRows = db
    .prepare<(string | number)[], { station_id: number; liters: number }>(
      `SELECT t.station_id, ROUND(SUM(t.dispensed_liters), 2) AS liters
       FROM transactions t
       JOIN stations s ON s.id = t.station_id
       WHERE t.status = 'completed'
         AND ${businessDayExpr("t")} BETWEEN ? AND ?
         ${scope.tenantId !== null ? "AND s.tenant_id = ?" : ""}
       GROUP BY t.station_id`
    )
    .all(...literParams);
  const litersByStation = new Map(literRows.map((r) => [r.station_id, r.liters]));

  const varianceByStation = getVarianceByStation(scope, from, to);

  const stations = rows.map((r) => ({
    ...r,
    liters: litersByStation.get(r.stationId) ?? 0,
    varianceLiters: varianceByStation.get(r.stationId) ?? null,
  }));

  return { from, to, stations, totals: buildTotals(stations) };
}

export function getPortfolioReport(scope: PortfolioScope, from: string, to: string): PortfolioReport {
  if (isDateRollupCovered(from)) return getPortfolioReportFast(scope, from, to);
  return getPortfolioReportLive(scope, from, to);
}
