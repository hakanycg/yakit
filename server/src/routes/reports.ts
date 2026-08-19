import { Router } from "express";
import { db } from "../db/index.js";
import { attachStationScope, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("super_admin", "admin", "operator", "viewer"), attachStationScope, requireStationSelected);

router.get("/summary", (req, res) => {
  const stationId = req.stationId!;

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) as transactionCount,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END), 0) as totalRevenue,
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
              COALESCE(SUM(total_amount), 0) as revenue,
              COALESCE(SUM(dispensed_liters), 0) as liters
       FROM transactions WHERE station_id = ? AND status = 'completed' GROUP BY fuel_type`
    )
    .all(stationId);

  const byDay = db
    .prepare(
      `SELECT substr(created_at, 1, 10) as day,
              COUNT(*) as count,
              COALESCE(SUM(total_amount), 0) as revenue
       FROM transactions WHERE station_id = ? AND status = 'completed'
       GROUP BY day ORDER BY day DESC LIMIT 30`
    )
    .all(stationId);

  const byPump = db
    .prepare(
      `SELECT p.number as pumpNumber,
              COUNT(t.id) as count,
              COALESCE(SUM(t.total_amount), 0) as revenue,
              COALESCE(SUM(t.dispensed_liters), 0) as liters
       FROM pumps p LEFT JOIN transactions t ON t.pump_id = p.id AND t.status = 'completed'
       WHERE p.station_id = ?
       GROUP BY p.id ORDER BY p.number`
    )
    .all(stationId);

  res.json({ totals, byFuelType, byDay, byPump });
});

export { router as reportsRouter };
