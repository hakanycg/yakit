import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { AlarmRow } from "../db/types.js";
import { attachStationScope, requireAuth, requireRole, requireStationSelected, csrfProtection } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { listAlarms, serializeAlarm, broadcastAlarms } from "../services/alarmService.js";
import { getPump, setPumpStatus } from "../services/pumpService.js";
import { recordAudit } from "../services/auditService.js";

const router = Router();
router.use(requireAuth, requireRole("super_admin", "admin", "operator", "viewer"), attachStationScope, requireStationSelected);

const listSchema = z.object({ status: z.enum(["active", "acknowledged", "resolved"]).optional() });

router.get("/", validateQuery(listSchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listSchema> }).validatedQuery;
  res.json({ alarms: listAlarms(req.stationId!, q.status).map(serializeAlarm) });
});

const noteSchema = z.object({ note: z.string().max(300).optional() });

function alarmInScope(req: { stationId?: number }, id: number): AlarmRow | undefined {
  const alarm = db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(id);
  if (!alarm || alarm.station_id !== req.stationId) return undefined;
  return alarm;
}

router.post("/:id/acknowledge", requireRole("admin", "operator"), csrfProtection, validateBody(noteSchema), (req, res) => {
  const id = Number(req.params.id);
  const alarm = alarmInScope(req, id);
  if (!alarm) return void res.status(404).json({ error: "Alarm bulunamadi." });

  db.prepare("UPDATE alarms SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?").run(
    req.user!.id,
    new Date().toISOString(),
    id
  );
  broadcastAlarms(req.stationId!);
  recordAudit({ user: req.user!, action: "alarm_acknowledged", entityType: "alarm", entityId: id, ip: req.ip, stationId: req.stationId });
  res.json({ alarm: serializeAlarm(db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(id)!) });
});

router.post("/:id/resolve", requireRole("admin", "operator"), csrfProtection, validateBody(noteSchema), (req, res) => {
  const id = Number(req.params.id);
  const alarm = alarmInScope(req, id);
  if (!alarm) return void res.status(404).json({ error: "Alarm bulunamadi." });

  db.prepare("UPDATE alarms SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ?").run(
    req.user!.id,
    new Date().toISOString(),
    id
  );

  // Bir pompa arizasi alarmi cozuldugunde, pompa da otomatik olarak kullanima acilir;
  // aksi halde alarm "cozuldu" gorunse bile pompa "ariza" durumunda kilitli kalirdi.
  if (alarm.type === "pump_fault" && alarm.pump_id) {
    const pump = getPump(alarm.pump_id);
    if (pump && pump.status === "fault") {
      setPumpStatus(pump.id, "idle", { faultCode: null, faultMessage: null });
      recordAudit({
        user: req.user!,
        action: "pump_fault_cleared_via_alarm",
        entityType: "pump",
        entityId: pump.id,
        details: { alarmId: id },
        ip: req.ip,
        stationId: req.stationId,
      });
    }
  }

  broadcastAlarms(req.stationId!);
  recordAudit({ user: req.user!, action: "alarm_resolved", entityType: "alarm", entityId: id, ip: req.ip, stationId: req.stationId });
  res.json({ alarm: serializeAlarm(db.prepare<[number], AlarmRow>("SELECT * FROM alarms WHERE id = ?").get(id)!) });
});

export { router as alarmsRouter };
