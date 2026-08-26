import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getSystemErrorHealth, listSystemErrors } from "../services/systemErrorService.js";
import { getArchiveHealth, listArchiveFiles } from "../services/archiveService.js";

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

/**
 * Arsiv durumu. Buradaki asil soru "kac dosya var" degil, `pending` sayilarinin
 * BUYUYUP BUYUMEDIGI: buyuyorsa tarama uretilen veriye yetismiyor demektir.
 *
 * Ozetler (content_sha256/file_sha256) burada da donuyor - gorev #110'daki KamuSM
 * zaman damgasi bunlari imzalayacak.
 */
router.get("/archives", (_req, res) => {
  res.json({
    health: getArchiveHealth(),
    files: listArchiveFiles(200).map((f) => ({
      id: f.id,
      table: f.table_name,
      fileName: f.file_name,
      rowCount: f.row_count,
      firstRowAt: f.first_row_at,
      lastRowAt: f.last_row_at,
      contentSha256: f.content_sha256,
      fileSha256: f.file_sha256,
      byteSize: f.byte_size,
      createdAt: f.created_at,
    })),
  });
});

export const systemHealthRouter = router;
