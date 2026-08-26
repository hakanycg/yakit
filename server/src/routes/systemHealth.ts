import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getSystemErrorHealth, listSystemErrors } from "../services/systemErrorService.js";

/**
 * Sunucu sagligi - PLATFORM yoneticisine ozel.
 *
 * Istasyon kapsami YOKTUR ve olmamalidir: sunucu hatasi tek bir istasyonun sorunu
 * degil, sistemin sorunudur. Istasyon yoneticisine gostermek de yanlis olurdu -
 * elinden gelen bir sey yok ve gorunce yapabilecegi tek sey endiselenmek.
 */
const router = Router();
router.use(requireAuth, requireRole("super_admin"));

router.get("/errors", (_req, res) => {
  res.json({
    health: getSystemErrorHealth(),
    errors: listSystemErrors(100).map((e) => ({
      id: e.id,
      kind: e.kind,
      path: e.path,
      message: e.message,
      createdAt: e.created_at,
    })),
  });
});

export const systemHealthRouter = router;
