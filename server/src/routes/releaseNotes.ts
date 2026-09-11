import { Router } from "express";
import { z } from "zod";
import { csrfProtection, requireAuth, requireRole } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  ReleaseNoteError,
  createReleaseNote,
  deleteReleaseNote,
  getUnseenReleaseNotes,
  listReleaseNotes,
  markReleaseNotesSeen,
  serializeReleaseNote,
} from "../services/releaseNoteService.js";

/**
 * "Yenilikler" duyurulari - istasyon/kiraci farki gozetmeksizin TUM kullanicilar
 * gorebilir (bkz. releaseNoteService.ts), yalnizca super_admin yazabilir/silebilir.
 * Station-scoped DEGILDIR: attachStationScope/requireStationSelected kasitli olarak yok.
 */

const router = Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  res.json({ notes: listReleaseNotes().map(serializeReleaseNote) });
});

router.get("/unseen", (req, res) => {
  res.json({ notes: getUnseenReleaseNotes(req.user!.id).map(serializeReleaseNote) });
});

router.post("/mark-seen", csrfProtection, (req, res) => {
  markReleaseNotesSeen(req.user!.id);
  res.status(204).end();
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});

router.post("/", requireRole("super_admin"), csrfProtection, validateBody(createSchema), (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;
  try {
    const note = createReleaseNote(body, req.user!);
    recordAudit({
      user: req.user!,
      action: "release_note_created",
      entityType: "release_note",
      entityId: note.id,
      details: { title: note.title },
      ip: req.ip,
    });
    res.status(201).json({ note: serializeReleaseNote(note) });
  } catch (err) {
    if (err instanceof ReleaseNoteError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.delete("/:id", requireRole("super_admin"), csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  try {
    deleteReleaseNote(id);
    recordAudit({ user: req.user!, action: "release_note_deleted", entityType: "release_note", entityId: id, details: {}, ip: req.ip });
    res.status(204).end();
  } catch (err) {
    if (err instanceof ReleaseNoteError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as releaseNotesRouter };
