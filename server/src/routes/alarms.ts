import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { AlarmRow } from "../db/types.js";
import { requireAuth, requireRole, csrfProtection } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { listAlarms, serializeAlarm, broadcastAlarms } from "../services/alarmService.js";
import { recordAudit } from "../services/auditService.js";

const router = Router();
router.use(requireAuth, requireRole("admin", "operator", "viewer"));

const listSchema = z.object({ status: z.enum(["active", "acknowledged", "resolved"]).optional() });

router.get("/", validateQuery(listSchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listSchema> }).validatedQuery;
  res.json({ alarms: listAlarms(q.status).map(serializeAlarm) });
});

const noteSchema = z.object({ note: z.string().max(300).optional() });

router.post("/:id/acknowledge", requireRole("admin", "operator"), csrfProtection, validateBody(noteSchema), (req, res) => {
  const id = Number(req.params.id);
  const alarm = db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(id);
  if (!alarm) return void res.status(404).json({ error: "Alarm bulunamadi." });

  db.prepare("UPDATE alarms SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?").run(
    req.user!.id,
    new Date().toISOString(),
    id
  );
  broadcastAlarms();
  recordAudit({ user: req.user!, action: "alarm_acknowledged", entityType: "alarm", entityId: id, ip: req.ip });
  res.json({ alarm: serializeAlarm(db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(id)!) });
});

router.post("/:id/resolve", requireRole("admin", "operator"), csrfProtection, validateBody(noteSchema), (req, res) => {
  const id = Number(req.params.id);
  const alarm = db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(id);
  if (!alarm) return void res.status(404).json({ error: "Alarm bulunamadi." });

  db.prepare("UPDATE alarms SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ?").run(
    req.user!.id,
    new Date().toISOString(),
    id
  );
  broadcastAlarms();
  recordAudit({ user: req.user!, action: "alarm_resolved", entityType: "alarm", entityId: id, ip: req.ip });
  res.json({ alarm: serializeAlarm(db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(id)!) });
});

export { router as alarmsRouter };
