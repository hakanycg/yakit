import { Router } from "express";
import { z } from "zod";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  SupportError,
  countOpenSupportRequests,
  listSupportRequests,
  resolveSupportRequest,
  serializeSupportRequest,
} from "../services/supportService.js";

/**
 * Musteri destek talepleri - panel tarafi. Talebe mudahale eden kisi genelde
 * operatordur, bu yuzden yakit stogunun aksine operator de erisebilir.
 */
const router = Router();
router.use(requireAuth, requireRole("super_admin", "admin", "operator"), attachStationScope, requireStationSelected);

const listQuerySchema = z.object({
  status: z.enum(["open", "resolved"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

router.get("/", validateQuery(listQuerySchema), (req, res) => {
  const { status, limit } = (req as unknown as { validatedQuery: z.infer<typeof listQuerySchema> }).validatedQuery;
  const rows = listSupportRequests(req.stationId!, status, limit);
  res.json({
    requests: rows.map((r) => serializeSupportRequest(r)),
    openCount: countOpenSupportRequests(req.stationId!),
  });
});

const resolveSchema = z.object({ note: z.string().trim().max(500).optional() });

router.post("/:id/resolve", csrfProtection, validateBody(resolveSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "Gecersiz talep kimligi." });

  try {
    const { note } = req.body as z.infer<typeof resolveSchema>;
    const request = resolveSupportRequest(id, req.stationId!, note ?? null, req.user!);

    recordAudit({
      user: req.user!,
      action: "support_request_resolved",
      entityType: "support_request",
      entityId: request.id,
      details: { category: request.category, note: request.resolution_note },
      ip: req.ip,
      stationId: req.stationId,
    });

    res.json({ request: serializeSupportRequest(request) });
  } catch (err) {
    if (err instanceof SupportError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export const supportRouter = router;
