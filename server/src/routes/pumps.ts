import { Router } from "express";
import { z } from "zod";
import { attachStationScope, requireAuth, requireRole, requireStationSelected, csrfProtection } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { getPump, listPumps, serializePump, setPumpStatus } from "../services/pumpService.js";
import { emergencyStopStation, emergencyStopTransaction, TransactionError } from "../services/transactionService.js";
import { createAlarm } from "../services/alarmService.js";
import { recordAudit } from "../services/auditService.js";
import {
  MAX_PERMISSIBLE_ERROR_PCT,
  PumpCalibrationError,
  getStationCalibrationStatus,
  listCalibrations,
  recordCalibration,
  serializeCalibration,
} from "../services/pumpCalibrationService.js";
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

const emergencyStopAllSchema = z.object({ reason: z.string().trim().max(300).optional() });

// Yangin/dokulme gibi acil bir durumda tek tikla istasyondaki TUM pompalari devre
// disi birakir - bkz. transactionService.ts emergencyStopStation(). Gorevli fiziksel
// olarak mudahale edip her pompayi tek tek /reset ile tekrar hizmete alana kadar
// istasyon tamamen kapali kalir.
router.post("/emergency-stop-all", requireRole("admin", "operator"), validateBody(emergencyStopAllSchema), (req, res) => {
  const { reason } = req.body as z.infer<typeof emergencyStopAllSchema>;
  const result = emergencyStopStation(req.stationId!, req.user!, reason?.trim() || "Acil durdurma butonuna basildi.");
  res.json({ pumps: listPumps(req.stationId!).map(serializePump), stoppedTransactions: result.stoppedTransactions });
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

// --- Kalibrasyon (ayar) testi ve damga -------------------------------------

router.get("/calibration-status", (req, res) => {
  res.json({ pumps: getStationCalibrationStatus(req.stationId!), maxErrorPct: MAX_PERMISSIBLE_ERROR_PCT });
});

router.get("/:id/calibrations", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz pompa kimligi." });
  try {
    res.json({ calibrations: listCalibrations(req.stationId!, id).map(serializeCalibration) });
  } catch (err) {
    if (err instanceof PumpCalibrationError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const calibrationSchema = z.object({
  fuelType: z.enum(["benzin", "motorin", "lpg"]),
  referenceLiters: z.number().positive().max(1000),
  meteredLiters: z.number().min(0).max(1000),
  sealValidUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sealReference: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
});

// csrfProtection router genelinde zaten uygulaniyor (yukaridaki router.use).
router.post("/:id/calibrations", requireRole("super_admin", "tenant_admin", "admin"), validateBody(calibrationSchema), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "Gecersiz pompa kimligi." });
  try {
    const body = req.body as z.infer<typeof calibrationSchema>;
    const calibration = recordCalibration(
      req.stationId!,
      id,
      {
        ...body,
        // Tarih gun bazinda girilir; gunun SONU kabul edilir - o gun damga hala gecerlidir.
        sealValidUntil: body.sealValidUntil ? `${body.sealValidUntil}T23:59:59.000Z` : null,
        sealReference: body.sealReference || null,
        note: body.note || null,
      },
      req.user!
    );
    recordAudit({
      user: req.user!,
      action: "pump_calibration_recorded",
      entityType: "pump",
      entityId: id,
      details: {
        referenceLiters: body.referenceLiters,
        meteredLiters: body.meteredLiters,
        errorPct: calibration.evaluation.errorPct,
        withinTolerance: calibration.evaluation.withinTolerance,
      },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ calibration: serializeCalibration(calibration), evaluation: calibration.evaluation });
  } catch (err) {
    if (err instanceof PumpCalibrationError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
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
