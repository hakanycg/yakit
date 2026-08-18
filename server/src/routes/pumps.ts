import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, csrfProtection } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { getPump, listPumps, serializePump, setPumpStatus } from "../services/pumpService.js";
import { emergencyStopTransaction, TransactionError } from "../services/transactionService.js";
import { createAlarm } from "../services/alarmService.js";
import { recordAudit } from "../services/auditService.js";

const router = Router();
router.use(requireAuth, csrfProtection);

router.get("/", (_req, res) => {
  res.json({ pumps: listPumps().map(serializePump) });
});

router.post("/:id/stop", requireRole("admin", "operator"), (req, res) => {
  const pump = getPump(Number(req.params.id));
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
  recordAudit({ user: req.user!, action: "pump_stopped", entityType: "pump", entityId: pump.id, ip: req.ip });
  res.json({ pump: serializePump(getPump(pump.id)!) });
});

router.post("/:id/start", requireRole("admin", "operator"), (req, res) => {
  const pump = getPump(Number(req.params.id));
  if (!pump) return void res.status(404).json({ error: "Pompa bulunamadi." });
  if (pump.status === "offline" || pump.status === "fault") {
    setPumpStatus(pump.id, "idle", { faultCode: null, faultMessage: null });
  }
  recordAudit({ user: req.user!, action: "pump_started", entityType: "pump", entityId: pump.id, ip: req.ip });
  res.json({ pump: serializePump(getPump(pump.id)!) });
});

router.post("/:id/reset", requireRole("admin", "operator"), (req, res) => {
  const pump = getPump(Number(req.params.id));
  if (!pump) return void res.status(404).json({ error: "Pompa bulunamadi." });

  if (pump.current_transaction_id) {
    try {
      emergencyStopTransaction(pump.current_transaction_id, req.user!, "Pompa sifirlandi.");
    } catch (err) {
      if (!(err instanceof TransactionError)) throw err;
    }
  }
  setPumpStatus(pump.id, "idle", { faultCode: null, faultMessage: null, currentTransactionId: null });
  recordAudit({ user: req.user!, action: "pump_reset", entityType: "pump", entityId: pump.id, ip: req.ip });
  res.json({ pump: serializePump(getPump(pump.id)!) });
});

const faultSchema = z.object({
  faultCode: z.string().min(1).max(32),
  faultMessage: z.string().min(1).max(200),
});

router.post("/:id/simulate-fault", requireRole("admin", "operator"), validateBody(faultSchema), (req, res) => {
  const pump = getPump(Number(req.params.id));
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
  createAlarm({ pumpId: pump.id, type: "pump_fault", severity: "critical", message: `Pompa ${pump.number}: ${faultMessage}` });
  recordAudit({
    user: req.user!,
    action: "pump_fault_simulated",
    entityType: "pump",
    entityId: pump.id,
    details: { faultCode, faultMessage },
    ip: req.ip,
  });
  res.json({ pump: serializePump(getPump(pump.id)!) });
});

export { router as pumpsRouter };
