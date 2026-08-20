import { Router } from "express";
import { z } from "zod";
import { attachStationScope, requireAuth, requireRole, requireStationSelected, csrfProtection } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { getPump, listPumps, serializePump, setPumpStatus } from "../services/pumpService.js";
import { emergencyStopTransaction, TransactionError } from "../services/transactionService.js";
import { createAlarm } from "../services/alarmService.js";
import { recordAudit } from "../services/auditService.js";
import { addMaintenanceLog, listMaintenanceLogs, serializeMaintenanceLog } from "../services/pumpMaintenanceService.js";

const router = Router();
router.use(requireAuth, attachStationScope, requireStationSelected, csrfProtection);

function pumpInScope(req: { stationId?: number }, pumpId: number) {
  const pump = getPump(pumpId);
  if (!pump || pump.station_id !== req.stationId) return undefined;
  return pump;
}

router.get("/", (req, res) => {
  res.json({ pumps: listPumps(req.stationId!).map(serializePump) });
});

router.post("/:id/stop", requireRole("admin", "operator"), (req, res) => {
  const pump = pumpInScope(req, Number(req.params.id));
  if (!pump) return void res.status(404).json({ error: "Pompa bulunamadi." });

  if (pump.current_transaction_id) {
    try {
      emergencyStopTransaction(pump.current_transaction_id, req.user!, "Operator tarafindan durduruldu.");
    } catch (err) {
      if (!(err instanceof TransactionError)) throw err;
    }
  } else {
    setPumpStatus(pump.id, "offline");
  }
  recordAudit({ user: req.user!, action: "pump_stopped", entityType: "pump", entityId: pump.id, ip: req.ip, stationId: req.stationId });
  res.json({ pump: serializePump(getPump(pump.id)!) });
});

router.post("/:id/start", requireRole("admin", "operator"), (req, res) => {
  const pump = pumpInScope(req, Number(req.params.id));
  if (!pump) return void res.status(404).json({ error: "Pompa bulunamadi." });
  if (pump.status === "offline" || pump.status === "fault") {
    setPumpStatus(pump.id, "idle", { faultCode: null, faultMessage: null });
  }
  recordAudit({ user: req.user!, action: "pump_started", entityType: "pump", entityId: pump.id, ip: req.ip, stationId: req.stationId });
  res.json({ pump: serializePump(getPump(pump.id)!) });
});

router.post("/:id/reset", requireRole("admin", "operator"), (req, res) => {
  const pump = pumpInScope(req, Number(req.params.id));
  if (!pump) return void res.status(404).json({ error: "Pompa bulunamadi." });

  if (pump.current_transaction_id) {
    try {
      emergencyStopTransaction(pump.current_transaction_id, req.user!, "Pompa sifirlandi.");
    } catch (err) {
      if (!(err instanceof TransactionError)) throw err;
    }
  }
  setPumpStatus(pump.id, "idle", { faultCode: null, faultMessage: null, currentTransactionId: null });
  recordAudit({ user: req.user!, action: "pump_reset", entityType: "pump", entityId: pump.id, ip: req.ip, stationId: req.stationId });
  res.json({ pump: serializePump(getPump(pump.id)!) });
});

const faultSchema = z.object({
  faultCode: z.string().min(1).max(32),
  faultMessage: z.string().min(1).max(200),
});

router.post("/:id/simulate-fault", requireRole("admin", "operator"), validateBody(faultSchema), (req, res) => {
  const pump = pumpInScope(req, Number(req.params.id));
  if (!pump) return void res.status(404).json({ error: "Pompa bulunamadi." });
  const { faultCode, faultMessage } = req.body as z.infer<typeof faultSchema>;

  if (pump.current_transaction_id) {
    try {
      emergencyStopTransaction(pump.current_transaction_id, req.user!, `Ariza: ${faultMessage}`);
    } catch (err) {
      if (!(err instanceof TransactionError)) throw err;
    }
  }

  setPumpStatus(pump.id, "fault", { faultCode, faultMessage, currentTransactionId: null });
  createAlarm({
    stationId: req.stationId!,
    pumpId: pump.id,
    type: "pump_fault",
    severity: "critical",
    message: `Pompa ${pump.number}: ${faultMessage}`,
  });
  recordAudit({
    user: req.user!,
    action: "pump_fault_simulated",
    entityType: "pump",
    entityId: pump.id,
    details: { faultCode, faultMessage },
    ip: req.ip,
    stationId: req.stationId,
  });
  res.json({ pump: serializePump(getPump(pump.id)!) });
});

router.get("/:id/maintenance-logs", (req, res) => {
  const pump = pumpInScope(req, Number(req.params.id));
  if (!pump) return void res.status(404).json({ error: "Pompa bulunamadi." });
  const logs = listMaintenanceLogs(req.stationId!, pump.id);
  res.json({ logs: logs.map((l) => serializeMaintenanceLog(l, l.username)) });
});

const maintenanceLogSchema = z.object({
  type: z.enum(["maintenance", "note"]).default("maintenance"),
  description: z.string().trim().min(3, "Aciklama zorunludur.").max(500),
});

router.post("/:id/maintenance-logs", requireRole("admin", "operator"), validateBody(maintenanceLogSchema), (req, res) => {
  const pump = pumpInScope(req, Number(req.params.id));
  if (!pump) return void res.status(404).json({ error: "Pompa bulunamadi." });
  const { type, description } = req.body as z.infer<typeof maintenanceLogSchema>;

  const log = addMaintenanceLog(req.stationId!, pump.id, type, description, req.user!);
  recordAudit({
    user: req.user!,
    action: "pump_maintenance_log_added",
    entityType: "pump",
    entityId: pump.id,
    details: { type, description },
    ip: req.ip,
    stationId: req.stationId,
  });
  res.status(201).json({ log: serializeMaintenanceLog(log, req.user!.username) });
});

export { router as pumpsRouter };
