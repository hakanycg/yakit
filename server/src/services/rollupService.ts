import { db } from "../db/index.js";
import { businessDateDaysAgo, businessDayExpr, currentBusinessDate } from "../utils/businessDay.js";

/**
 * Konsolide rapor icin gunluk ozet (rollup).
 *
 * Kapasite olcumu (bkz. README "Kapasite olcumu"), portfolioService.ts'in istasyon
 * basina transactions tablosuna korele alt sorgu calistirdigini ve bunun 100
 * istasyonda 1,6 saniyeye, 1000 istasyonda tahmini ~16 saniyeye ciktigini gosterdi -
 * tek gercek darbogaz buydu. Bu servis o alt sorgularin urettigi TOPLAMLARI onceden
 * hesaplayip station_daily_rollups tablosuna yazar; portfolioService kapsam
 * dahilindeki gunler icin artik transactions'i degil bu tabloyu okur.
 *
 * IKI ASAMALI CALISIR:
 *
 * 1) TEK SEFERLIK GERIYE DOLDURMA (backfill): ozellik ilk devreye alindiginda ya da
 *    rollup_state hic yoksa, EN ESKI islemden bugune KADAR tum gecmis tek seferde
 *    hesaplanir. Bu, olcek ne olursa olsun BIR KEZ odenen bir maliyettir.
 *
 * 2) KAYAN PENCERE (son 7 gun) her calistirmada YENIDEN hesaplanir - gec gelen bir
 *    iade/duzeltme eski bir gunun rakamini degistirebilir (bkz. refundService.ts:
 *    iade KESILDIGI gunun kasasina yazilir). Pencere bunu bir sonraki calistirmada
 *    otomatik telafi eder. Ayni ilke archiveService.ts'te de var: fazladan hesaplamak
 *    bedavadir, riskli olan bayat/eksik veridir.
 *
 * Pencerenin disindaki (covered_from'dan daha eski) gunler bir daha hesaplanmaz -
 * sonsuza dek her gunu yeniden hesaplamak, tam da bu tablonun onlemeye calistigi
 * maliyeti geri getirirdi.
 */
const TRAILING_WINDOW_DAYS = 7;

interface RollupStateRow {
  covered_from: string | null;
  last_run_at: string | null;
}

function getState(): RollupStateRow {
  const row = db.prepare<[], RollupStateRow>("SELECT covered_from, last_run_at FROM rollup_state WHERE id = 1").get();
  return row ?? { covered_from: null, last_run_at: null };
}

/** En eski TAMAMLANMIS islemin is gunu. Islem yoksa null (hesaplayacak bir sey yok). */
function earliestBusinessDate(): string | null {
  const row = db
    .prepare<[], { d: string | null }>(`SELECT MIN(${businessDayExpr("t")}) AS d FROM transactions t WHERE t.status = 'completed'`)
    .get();
  return row?.d ?? null;
}

export interface RefreshRollupsResult {
  from: string | null;
  to: string;
  rowsWritten: number;
  wasBackfill: boolean;
}

/**
 * Rollup'i gunceller. `covered_from` yoksa (ilk calistirma) TUM gecmisi geriye dogru
 * doldurur; aksi halde yalnizca son TRAILING_WINDOW_DAYS gunu yeniden hesaplar.
 */
export function refreshRollups(now = new Date()): RefreshRollupsResult {
  const to = currentBusinessDate(now);
  const state = getState();

  const wasBackfill = state.covered_from === null;
  const from = wasBackfill ? earliestBusinessDate() : businessDateDaysAgo(TRAILING_WINDOW_DAYS - 1, now);

  if (from === null) {
    // Sistemde hic tamamlanmis islem yok - hesaplanacak bir sey yok, ama kapsami
    // yine de "bugune kadar guvenilir" olarak isaretleriz ki portfolioService
    // bos donen sonucu "henuz hesaplanmadi" sanip canli yola dusmesin.
    upsertState(to, now);
    return { from: null, to, rowsWritten: 0, wasBackfill };
  }

  const rows = db
    .prepare<[string, string], { station_id: number; business_date: string; c: number; revenue: number; discount: number; liters: number }>(
      `SELECT
         t.station_id AS station_id,
         ${businessDayExpr("t")} AS business_date,
         COUNT(*) AS c,
         ROUND(SUM(MAX(0, t.total_amount - t.discount_amount)), 2) AS revenue,
         ROUND(SUM(t.discount_amount), 2) AS discount,
         ROUND(SUM(t.dispensed_liters), 2) AS liters
       FROM transactions t
       WHERE t.status = 'completed' AND ${businessDayExpr("t")} BETWEEN ? AND ?
       GROUP BY t.station_id, business_date`
    )
    .all(from, to);

  const upsertRow = db.prepare(
    `INSERT INTO station_daily_rollups (station_id, business_date, transaction_count, revenue, discount, liters, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(station_id, business_date) DO UPDATE SET
       transaction_count = excluded.transaction_count,
       revenue = excluded.revenue,
       discount = excluded.discount,
       liters = excluded.liters,
       updated_at = excluded.updated_at`
  );

  const nowIso = now.toISOString();
  db.transaction(() => {
    for (const r of rows) {
      upsertRow.run(r.station_id, r.business_date, r.c, r.revenue, r.discount, r.liters, nowIso);
    }
    // Kapsam, backfill'de bu calistirmanin gittigi en eski gune; kayan pencerede
    // ise (zaten daha once tam gecmis doldurulmus oldugundan) OLDUGU GIBI kalmali
    // - trailing window covered_from'u GERI CEKMEZ, yalnizca ileri kaydirir.
    upsertState(wasBackfill ? from : state.covered_from!, now);
  })();

  return { from, to, rowsWritten: rows.length, wasBackfill };
}

function upsertState(coveredFrom: string, now: Date): void {
  db.prepare(
    `INSERT INTO rollup_state (id, covered_from, last_run_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET covered_from = excluded.covered_from, last_run_at = excluded.last_run_at`
  ).run(coveredFrom, now.toISOString());
}

/** `date`, rollup'in guvenilir oldugu kapsamin icinde mi? Kapsam disindaysa (henuz
 * hic calismadi ya da bu tarih ilk backfill'den daha eski) cagiran taraf canli
 * sorguya dusmelidir. */
export function isDateRollupCovered(date: string): boolean {
  const state = getState();
  return state.covered_from !== null && date >= state.covered_from;
}

export interface RollupTotals {
  transactionCount: number;
  revenue: number;
  discount: number;
  liters: number;
}

/**
 * TEK bir is gununun istasyon basina islem toplamlarini CANLI hesaplar (rollup
 * tablosuna yazmadan, sadece okur gibi). portfolioService, "bugun" - hicbir zaman
 * rollup'a guvenilmeyen, hep buyumekte olan tek gun - icin bunu kullanir.
 *
 * refreshRollups()'un ic sorgusuyla AYNI toplamlari uretir ama tek tarih icin ve
 * kalici yazma yapmaz - bu yuzden ayri tutulur, birbirine cagrilmaz.
 */
export function getLiveTotalsForDate(tenantId: number | null, date: string): Map<number, RollupTotals> {
  const params: (string | number)[] = [date, date];
  if (tenantId !== null) params.push(tenantId);

  const rows = db
    .prepare<(string | number)[], { station_id: number; c: number; revenue: number; discount: number; liters: number }>(
      `SELECT t.station_id, COUNT(*) AS c,
              ROUND(SUM(MAX(0, t.total_amount - t.discount_amount)), 2) AS revenue,
              ROUND(SUM(t.discount_amount), 2) AS discount,
              ROUND(SUM(t.dispensed_liters), 2) AS liters
       FROM transactions t
       JOIN stations s ON s.id = t.station_id
       WHERE t.status = 'completed' AND ${businessDayExpr("t")} BETWEEN ? AND ?
         ${tenantId !== null ? "AND s.tenant_id = ?" : ""}
       GROUP BY t.station_id`
    )
    .all(...params);

  return new Map(rows.map((r) => [r.station_id, { transactionCount: r.c, revenue: r.revenue, discount: r.discount, liters: r.liters }]));
}

/**
 * `[from, to]` araligindaki, tenant filtresine uyan istasyonlar icin var olan rollup
 * satirlarini istasyon bazinda toplar. Kapsam kontrolu cagiran tarafin (portfolioService)
 * sorumlulugundadir - bu fonksiyon yalnizca elindeki satirlari toplar.
 */
export function getRollupTotals(tenantId: number | null, from: string, to: string): Map<number, RollupTotals> {
  const params: (string | number)[] = [from, to];
  if (tenantId !== null) params.push(tenantId);

  const rows = db
    .prepare<(string | number)[], { station_id: number; c: number; revenue: number; discount: number; liters: number }>(
      `SELECT r.station_id, SUM(r.transaction_count) AS c, SUM(r.revenue) AS revenue,
              SUM(r.discount) AS discount, SUM(r.liters) AS liters
       FROM station_daily_rollups r
       JOIN stations s ON s.id = r.station_id
       WHERE r.business_date BETWEEN ? AND ?
         ${tenantId !== null ? "AND s.tenant_id = ?" : ""}
       GROUP BY r.station_id`
    )
    .all(...params);

  return new Map(
    rows.map((r) => [
      r.station_id,
      {
        transactionCount: r.c,
        revenue: Math.round(r.revenue * 100) / 100,
        discount: Math.round(r.discount * 100) / 100,
        liters: Math.round(r.liters * 100) / 100,
      },
    ])
  );
}
