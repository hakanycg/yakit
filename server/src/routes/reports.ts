import { Router } from "express";
import { db } from "../db/index.js";
import { attachStationScope, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("super_admin", "admin", "operator", "viewer"), attachStationScope, requireStationSelected);

router.get("/summary", (req, res) => {
  const stationId = req.stationId!;

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
       FROM transactions WHERE station_id = ?`
    )
    .get(stationId);

  const byFuelType = db
    .prepare(
      `SELECT fuel_type as fuelType,
              COUNT(*) as count,
              COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0) as revenue,
              COALESCE(SUM(discount_amount), 0) as discount,
              COALESCE(SUM(total_amount), 0) as grossRevenue,
              COALESCE(SUM(dispensed_liters), 0) as liters
       FROM transactions WHERE station_id = ? AND status = 'completed' GROUP BY fuel_type`
    )
    .all(stationId) as { fuelType: string; count: number; revenue: number; discount: number; grossRevenue: number; liters: number }[];

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
       FROM transactions WHERE station_id = ? AND status = 'completed'
       GROUP BY day ORDER BY day DESC LIMIT 30`
    )
    .all(stationId);

  const byPaymentMethod = db
    .prepare(
      `SELECT payment_method as paymentMethod,
              COUNT(*) as count,
              COALESCE(SUM(MAX(0, total_amount - discount_amount)), 0) as revenue
       FROM transactions WHERE station_id = ? AND status = 'completed' GROUP BY payment_method`
    )
    .all(stationId);

  const byPump = db
    .prepare(
      `SELECT p.number as pumpNumber,
              COUNT(t.id) as count,
              COALESCE(SUM(MAX(0, t.total_amount - t.discount_amount)), 0) as revenue,
              COALESCE(SUM(t.dispensed_liters), 0) as liters
       FROM pumps p LEFT JOIN transactions t ON t.pump_id = p.id AND t.status = 'completed'
       WHERE p.station_id = ?
       GROUP BY p.id ORDER BY p.number`
    )
    .all(stationId);

  res.json({ totals, byFuelType: byFuelTypeWithProfit, byDay, byPump, byPaymentMethod });
});

export { router as reportsRouter };
