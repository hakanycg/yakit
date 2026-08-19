import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { ShiftRow, UserRow } from "../db/types.js";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";

const router = Router();
router.use(requireAuth, requireRole("super_admin", "admin", "operator", "viewer"), attachStationScope, requireStationSelected);

interface ShiftStats {
  transactionCount: number;
  revenue: number;
  liters: number;
}

function computeShiftStats(stationId: number, startedAt: string, endedAt: string | null): ShiftStats {
  const row = db
    .prepare<[number, string, string], ShiftStats>(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as transactionCount,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END), 0) as revenue,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN dispensed_liters ELSE 0 END), 0) as liters
       FROM transactions
       WHERE station_id = ? AND completed_at >= ? AND completed_at <= ?`
    )
    .get(stationId, startedAt, endedAt ?? new Date().toISOString())!;
  return row;
}

function serializeShift(s: ShiftRow, username: string, displayName: string, stats?: ShiftStats) {
  return {
    id: s.id,
    stationId: s.station_id,
    userId: s.user_id,
    username,
    displayName,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    openingNote: s.opening_note,
    closingNote: s.closing_note,
    createdAt: s.created_at,
    stats: stats ?? null,
  };
}

router.get("/current", (req, res) => {
  const shift = db
    .prepare<[number, number], ShiftRow>("SELECT * FROM shifts WHERE station_id = ? AND user_id = ? AND ended_at IS NULL")
    .get(req.stationId!, req.user!.id);
  if (!shift) return void res.json({ shift: null });
  const stats = computeShiftStats(shift.station_id, shift.started_at, null);
  res.json({ shift: serializeShift(shift, req.user!.username, req.user!.display_name, stats) });
});

router.get("/", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db
    .prepare<[number, number], ShiftRow & { username: string; display_name: string }>(
      `SELECT sh.*, u.username, u.display_name
       FROM shifts sh JOIN users u ON u.id = sh.user_id
       WHERE sh.station_id = ?
       ORDER BY sh.started_at DESC LIMIT ?`
    )
    .all(req.stationId!, limit);

  const shifts = rows.map((r) => {
    const stats = computeShiftStats(r.station_id, r.started_at, r.ended_at);
    return serializeShift(r, r.username, r.display_name, stats);
  });
  res.json({ shifts });
});

router.get("/summary", (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from : null;
  const to = typeof req.query.to === "string" ? req.query.to : null;

  const clauses = ["sh.station_id = ?"];
  const params: unknown[] = [req.stationId!];
  if (from) {
    clauses.push("sh.started_at >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("sh.started_at <= ?");
    params.push(to);
  }

  const rows = db
    .prepare<
      unknown[],
      { userId: number; username: string; displayName: string; shiftCount: number; transactionCount: number; revenue: number; liters: number }
    >(
      `SELECT
         u.id as userId, u.username as username, u.display_name as displayName,
         COUNT(DISTINCT sh.id) as shiftCount,
         COALESCE(SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END), 0) as transactionCount,
         COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.total_amount ELSE 0 END), 0) as revenue,
         COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.dispensed_liters ELSE 0 END), 0) as liters
       FROM shifts sh
       JOIN users u ON u.id = sh.user_id
       LEFT JOIN transactions t
         ON t.station_id = sh.station_id
         AND t.completed_at >= sh.started_at
         AND t.completed_at <= COALESCE(sh.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       WHERE ${clauses.join(" AND ")}
       GROUP BY u.id
       ORDER BY liters DESC`
    )
    .all(...params);

  res.json({ summary: rows });
});

const startSchema = z.object({ openingNote: z.string().max(300).optional() });

router.post("/start", requireRole("admin", "operator"), csrfProtection, validateBody(startSchema), (req, res) => {
  // Ayni istasyonda ayni anda birden fazla acik vardiya olmasina izin verilmez;
  // aksi halde bu araliktaki islemler birden fazla vardiyanin istatistiklerinde
  // (satis/litre) mukerrer sayilir. Onceki vardiya kapatilmadan yenisi acilamaz.
  const existing = db
    .prepare<[number], ShiftRow & { username: string; display_name: string }>(
      `SELECT sh.*, u.username, u.display_name FROM shifts sh JOIN users u ON u.id = sh.user_id
       WHERE sh.station_id = ? AND sh.ended_at IS NULL`
    )
    .get(req.stationId!);
  if (existing) {
    const who = existing.user_id === req.user!.id ? "Zaten acik bir vardiyaniz var." : `Bu istasyonda halihazirda acik bir vardiya var (${existing.display_name}); once o vardiyanin kapatilmasi gerekiyor.`;
    return void res.status(409).json({ error: who });
  }

  const { openingNote } = req.body as z.infer<typeof startSchema>;
  const result = db
    .prepare("INSERT INTO shifts (station_id, user_id, opening_note) VALUES (?, ?, ?)")
    .run(req.stationId!, req.user!.id, openingNote ?? null);

  recordAudit({
    user: req.user!,
    action: "shift_started",
    entityType: "shift",
    entityId: result.lastInsertRowid as number,
    ip: req.ip,
    stationId: req.stationId,
  });

  const shift = db.prepare<[number], ShiftRow>("SELECT * FROM shifts WHERE id = ?").get(result.lastInsertRowid as number)!;
  res.status(201).json({ shift: serializeShift(shift, req.user!.username, req.user!.display_name) });
});

const endSchema = z.object({ closingNote: z.string().max(300).optional() });

router.post("/:id/end", requireRole("admin", "operator"), csrfProtection, validateBody(endSchema), (req, res) => {
  const id = Number(req.params.id);
  const shift = db.prepare<[number], ShiftRow>("SELECT * FROM shifts WHERE id = ?").get(id);
  if (!shift || shift.station_id !== req.stationId) return void res.status(404).json({ error: "Vardiya bulunamadi." });
  if (shift.ended_at) return void res.status(409).json({ error: "Vardiya zaten kapatilmis." });

  const requesterIsManager = req.role!.name === "super_admin" || req.role!.name === "admin";
  if (shift.user_id !== req.user!.id && !requesterIsManager) {
    return void res.status(403).json({ error: "Sadece kendi vardiyanizi kapatabilirsiniz." });
  }

  const { closingNote } = req.body as z.infer<typeof endSchema>;
  const endedAt = new Date().toISOString();
  db.prepare("UPDATE shifts SET ended_at = ?, closing_note = ? WHERE id = ?").run(endedAt, closingNote ?? null, id);

  const owner = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(shift.user_id)!;
  const stats = computeShiftStats(shift.station_id, shift.started_at, endedAt);

  recordAudit({
    user: req.user!,
    action: "shift_ended",
    entityType: "shift",
    entityId: id,
    details: stats,
    ip: req.ip,
    stationId: req.stationId,
  });

  const updated = db.prepare<[number], ShiftRow>("SELECT * FROM shifts WHERE id = ?").get(id)!;
  res.json({ shift: serializeShift(updated, owner.username, owner.display_name, stats) });
});

export { router as shiftsRouter };
