import { db } from "../db/index.js";
import { BUSINESS_DAY_SQL_OFFSET, businessDayExpr } from "../utils/businessDay.js";

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

/**
 * Istasyon basina ozet.
 *
 * Alt sorgular yerine tek gecis: her istasyon icin ayri ayri COUNT calistirmak 40
 * istasyonda 200+ sorgu demekti. Alarm/destek/sapma sayimlari da ayni satirda,
 * korele alt sorgularla cekiliyor - SQLite bunlari indeksli okur ve istasyon sayisi
 * arttikca sorgu SAYISI sabit kalir.
 */
export function getPortfolioReport(scope: PortfolioScope, from: string, to: string): PortfolioReport {
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

  // Litre ve sapma ayri cekiliyor: ikisi de farkli tablolardan geliyor ve yukaridaki
  // sorguya daha fazla korele alt sorgu eklemek okunurlugu bozardi. Ikisi de TEK
  // sorgu, sonuc bellekte eslestiriliyor.
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

  const varianceParams: (string | number)[] = [from, to];
  if (scope.tenantId !== null) varianceParams.push(scope.tenantId);
  const varianceRows = db
    .prepare<(string | number)[], { station_id: number; variance: number }>(
      `SELECT r.station_id, ROUND(SUM(r.variance_liters), 2) AS variance
       FROM fuel_tank_readings r
       JOIN stations s ON s.id = r.station_id
       WHERE date(r.measured_at, '${BUSINESS_DAY_SQL_OFFSET}') BETWEEN ? AND ?
         ${scope.tenantId !== null ? "AND s.tenant_id = ?" : ""}
       GROUP BY r.station_id`
    )
    .all(...varianceParams);
  const varianceByStation = new Map(varianceRows.map((r) => [r.station_id, r.variance]));

  const stations = rows.map((r) => ({
    ...r,
    liters: litersByStation.get(r.stationId) ?? 0,
    varianceLiters: varianceByStation.get(r.stationId) ?? null,
  }));

  const totals: PortfolioTotals = {
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

  return { from, to, stations, totals };
}
