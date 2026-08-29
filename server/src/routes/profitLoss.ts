import { Router } from "express";
import { z } from "zod";
import { attachStationScope, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { getProfitLossSummary } from "../services/profitLossService.js";

const router = Router();
// Mali veri: operator/viewer goremez - expenses.ts/supplierLedger.ts/cashAccounts.ts
// ile ayni gerekce, on muhasebe serisinin tutarliligi icin.
router.use(requireAuth, requireRole("super_admin", "tenant_admin", "admin"), attachStationScope, requireStationSelected);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.");
const querySchema = z.object({ from: dateSchema.optional(), to: dateSchema.optional() });

router.get("/", validateQuery(querySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof querySchema> }).validatedQuery;
  res.json({ summary: getProfitLossSummary(req.stationId!, q.from, q.to) });
});

export { router as profitLossRouter };
