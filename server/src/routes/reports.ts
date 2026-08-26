import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { attachStationScope, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";

const router = Router();
/**
 * Ciro/kar raporlari isletmenin bilgisidir, sahada calisan kisinin degil: operator
 * pompalari, dolumu, alarmlari ve destek taleplerini gorur - kazanc rakamlarini gormez.
 * Bu ayrim burada, sunucuda uygulanir; panelde kartlarin gizlenmesi yalnizca gorsel
 * bir sadelestirmedir.
 */
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin", "viewer"), attachStationScope, requireStationSelected);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.");
const rangeSchema = z.object({ from: dateSchema.optional(), to: dateSchema.optional() });

/**
 * Tarih araligini SQL parcasina cevirir.
 *
 * created_at ISO metin oldugundan karsilastirma metin uzerinden yapilir; "to" gunun
 * KENDISI de rapora dahil olmali, bu yuzden gun sonuna kadar uzatilir - aksi halde
 * bitis gununde yapilan tum satislar rapordan dusuyordu.
 */
function rangeClause(q: { from?: string; to?: string }, column = "created_at"): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (q.from) {
    parts.push(`${column} >= ?`);
    params.push(q.from);
  }
  if (q.to) {
    parts.push(`${column} <= ?`);
    params.push(`${q.to}T23:59:59.999Z`);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

router.get("/summary", validateQuery(rangeSchema), (req, res) => {
  const stationId = req.stationId!;
  const q = (req as unknown as { validatedQuery: z.infer<typeof rangeSchema> }).validatedQuery;
  const range = rangeClause(q);
  /** stationId + tarih araligi parametreleri - her sorguda ayni sirada. */
  const p = () => [stationId, ...range.params];

  // "revenue" alanlari, indirim/puan kullanimiyla dusen tutari CIKARILMIS gercek tahsilat
  // tutarini (chargeAmount = MAX(0, total_amount - discount_amount)) yansitir - transactionService.ts
  // ile ayni mantik. total_amount, yakit degerini (stok/rapor amacli) degismeden tutar; musteriden
  // gercekte tahsil edilen ile karistirilmamasi icin ciro raporlarinda ayrica totalDiscount raporlanir.
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) as transactionCount,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN MAX(0, total_amount - discount_amount) ELSE 0 END), 0) as totalRevenue,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN discount_amount ELSE 0 END), 0) as totalDiscount,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN dispensed_liters ELSE 0 END), 0) as totalLiters,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completedCount,
         COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) as cancelledCount,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failedCount
       FROM transactions WHERE station_id = ?${range.sql}`
    )
    .get(...p());

  const byFuelType = db
    .prepare(
      `SELECT fuel_type as fuelType,
              COUNT(*) as count,
              COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0) as revenue,
              COALESCE(SUM(discount_amount), 0) as discount,
              COALESCE(SUM(total_amount), 0) as grossRevenue,
              COALESCE(SUM(dispensed_liters), 0) as liters
       FROM transactions WHERE station_id = ? AND status = 'completed'${range.sql} GROUP BY fuel_type`
    )
    .all(...p()) as { fuelType: string; count: number; revenue: number; discount: number; grossRevenue: number; liters: number }[];

  // Tahmini brut kar: satilan litre * tankin GUNCEL agirlikli ortalama maliyeti (average_cost_per_liter).
  // Bu bir YAKLASIM'dir - satis anindaki gercek maliyet degil, su anki ortalama maliyet kullanilir
  // (transactions tablosu maliyet degil satis fiyati tutar). Maliyeti hic girilmemis (average_cost_per_liter=0)
  // bir yakit tipi icin kar hesaplanamaz, bu durumda estimatedGrossProfit null doner.
  const avgCosts = db
    .prepare(`SELECT fuel_type as fuelType, average_cost_per_liter as avgCost FROM fuel_tanks WHERE station_id = ?`)
    .all(stationId) as { fuelType: string; avgCost: number }[];
  const avgCostByFuel = new Map(avgCosts.map((r) => [r.fuelType, r.avgCost]));

  const byFuelTypeWithProfit = byFuelType.map((row) => {
    const avgCost = avgCostByFuel.get(row.fuelType) ?? 0;
    return {
      ...row,
      avgCostPerLiter: avgCost > 0 ? avgCost : null,
      estimatedGrossProfit: avgCost > 0 ? Math.round((row.revenue - avgCost * row.liters) * 100) / 100 : null,
    };
  });

  const byDay = db
    .prepare(
      `SELECT substr(created_at, 1, 10) as day,
              COUNT(*) as count,
              COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0) as revenue
       FROM transactions WHERE station_id = ? AND status = 'completed'${range.sql}
       GROUP BY day ORDER BY day DESC LIMIT 90`
    )
    .all(...p());

  const byPaymentMethod = db
    .prepare(
      `SELECT payment_method as paymentMethod,
              COUNT(*) as count,
              COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0) as revenue
       FROM transactions WHERE station_id = ? AND status = 'completed'${range.sql} GROUP BY payment_method`
    )
    .all(...p());

  // Tarih suzgeci JOIN kosulunda durmali (WHERE'de degil): WHERE'e konsaydi o aralikta
  // hic satis yapmamis pompalar listeden tamamen dusup "0 satis" bilgisi kaybolurdu.
  const pumpRange = rangeClause(q, "t.created_at");
  const byPump = db
    .prepare(
      `SELECT p.number as pumpNumber,
              COUNT(t.id) as count,
              COALESCE(SUM(MAX(0, t.total_amount - t.discount_amount)), 0) as revenue,
              COALESCE(SUM(t.dispensed_liters), 0) as liters
       FROM pumps p LEFT JOIN transactions t
              ON t.pump_id = p.id AND t.status = 'completed'${pumpRange.sql}
       WHERE p.station_id = ?
       GROUP BY p.id ORDER BY p.number`
    )
    .all(...pumpRange.params, stationId);

  // Saat dagilimi: gunun hangi saatlerinde yogunuz - vardiya planlamasinin dayanagi.
  // created_at UTC saklandigi icin yerel saate cevriliyor; aksi halde "yogun saat"
  // saat farki kadar kayik cikardi.
  const byHour = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) as hour,
              COUNT(*) as count,
              COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0) as revenue
       FROM transactions WHERE station_id = ? AND status = 'completed'${range.sql}
       GROUP BY hour ORDER BY hour`
    )
    .all(...p());

  res.json({ totals, byFuelType: byFuelTypeWithProfit, byDay, byPump, byPaymentMethod, byHour });
});

/**
 * Iade raporu.
 *
 * Iade, islem uzerinde bir bayrak degil kendi basina bir olaydir (bkz. refundService.ts);
 * ciro raporunun bir satiri olarak gosterilemez, kendi raporunu hak eder. Iade
 * GERCEKLESTIGI gune yazilir - orijinal satisin gunune degil; gun sonu mutabakati da
 * ayni kurali kullanir, iki rapor birbirini tutsun diye.
 */
router.get("/refunds", validateQuery(rangeSchema), (req, res) => {
  const stationId = req.stationId!;
  const q = (req as unknown as { validatedQuery: z.infer<typeof rangeSchema> }).validatedQuery;
  const range = rangeClause(q, "r.created_at");
  const params = [stationId, ...range.params];

  const totals = db
    .prepare(
      `SELECT COUNT(*) as refundCount, COALESCE(SUM(r.amount), 0) as refundedAmount
         FROM refunds r
        WHERE r.station_id = ? AND r.status = 'completed'${range.sql}`
    )
    .get(...params);

  const byDay = db
    .prepare(
      `SELECT substr(r.created_at, 1, 10) as day, COUNT(*) as count, COALESCE(SUM(r.amount), 0) as amount
         FROM refunds r
        WHERE r.station_id = ? AND r.status = 'completed'${range.sql}
        GROUP BY day ORDER BY day DESC LIMIT 90`
    )
    .all(...params);

  const byMethod = db
    .prepare(
      `SELECT r.payment_method as paymentMethod, COUNT(*) as count, COALESCE(SUM(r.amount), 0) as amount
         FROM refunds r
        WHERE r.station_id = ? AND r.status = 'completed'${range.sql}
        GROUP BY r.payment_method ORDER BY amount DESC`
    )
    .all(...params);

  const recent = db
    .prepare(
      `SELECT r.id, r.transaction_id as transactionId, r.amount, r.reason,
              r.payment_method as paymentMethod, r.created_at as createdAt,
              t.plate, u.username
         FROM refunds r
         JOIN transactions t ON t.id = r.transaction_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.station_id = ? AND r.status = 'completed'${range.sql}
        ORDER BY r.created_at DESC LIMIT 100`
    )
    .all(...params);

  res.json({ totals, byDay, byMethod, recent });
});

export { router as reportsRouter };
