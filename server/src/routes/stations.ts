import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { attachStationScope, csrfProtection, requireAuth, requireRole, requireStationSelected } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";

const router = Router();
router.use(requireAuth, attachStationScope);

function serializeStation(s: StationRow) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    address: s.address,
    latitude: s.latitude,
    longitude: s.longitude,
    active: !!s.active,
    createdAt: s.created_at,
  };
}

router.get("/current", requireStationSelected, (req, res) => {
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(req.stationId!);
  if (!station) return void res.status(404).json({ error: "Istasyon bulunamadi." });
  res.json({ station: serializeStation(station) });
});

router.get("/", requireRole("super_admin"), (_req, res) => {
  const stations = db.prepare<[], StationRow>("SELECT * FROM stations ORDER BY name").all();
  const withStats = stations.map((s) => {
    const pumpCount = (db.prepare("SELECT COUNT(*) as c FROM pumps WHERE station_id = ?").get(s.id) as { c: number }).c;
    const activeAlarms = (
      db.prepare("SELECT COUNT(*) as c FROM alarms WHERE station_id = ? AND status = 'active'").get(s.id) as { c: number }
    ).c;
    const userCount = (db.prepare("SELECT COUNT(*) as c FROM users WHERE station_id = ?").get(s.id) as { c: number }).c;
    const transactionCount = (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE station_id = ?").get(s.id) as { c: number }).c;
    return { ...serializeStation(s), pumpCount, activeAlarms, userCount, transactionCount };
  });
  res.json({ stations: withStats });
});

const createSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]{2,40}$/, "Slug yalnizca kucuk harf, rakam ve tire icerebilir (orn: merkez-istasyon)."),
  name: z.string().min(2).max(120),
  address: z.string().max(300).optional().default(""),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  pumpCount: z.number().int().min(1).max(16).optional().default(4),
});

const PUMP_POSITIONS = [
  { x: 20, y: 30 }, { x: 45, y: 30 }, { x: 20, y: 65 }, { x: 45, y: 65 },
  { x: 70, y: 30 }, { x: 70, y: 65 }, { x: 95, y: 30 }, { x: 95, y: 65 },
];

const DEFAULT_FUEL_PRICES = [
  { fuelType: "benzin", label: "Kursunsuz Benzin 95", price: 44.5 },
  { fuelType: "motorin", label: "Motorin (Diesel)", price: 43.2 },
  { fuelType: "lpg", label: "Otogaz LPG", price: 21.9 },
];

const DEFAULT_FUEL_TANKS = [
  { fuelType: "benzin", capacity: 10000, current: 0, threshold: 1500 },
  { fuelType: "motorin", capacity: 10000, current: 0, threshold: 1500 },
  { fuelType: "lpg", capacity: 5000, current: 0, threshold: 750 },
];

router.post("/", requireRole("super_admin"), csrfProtection, validateBody(createSchema), (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;

  const existing = db.prepare("SELECT id FROM stations WHERE slug = ?").get(body.slug);
  if (existing) return void res.status(409).json({ error: "Bu slug zaten kullaniliyor." });

  const create = db.transaction(() => {
    const result = db
      .prepare("INSERT INTO stations (slug, name, address, latitude, longitude) VALUES (?, ?, ?, ?, ?)")
      .run(body.slug, body.name, body.address, body.latitude ?? null, body.longitude ?? null);
    const stationId = result.lastInsertRowid as number;

    const insertPrice = db.prepare(
      "INSERT INTO fuel_prices (station_id, fuel_type, label, price_per_liter) VALUES (?, ?, ?, ?)"
    );
    for (const p of DEFAULT_FUEL_PRICES) insertPrice.run(stationId, p.fuelType, p.label, p.price);

    const insertPump = db.prepare(
      `INSERT INTO pumps (station_id, number, label, status, fuel_types, pos_x, pos_y) VALUES (?, ?, ?, 'idle', ?, ?, ?)`
    );
    for (let i = 0; i < body.pumpCount; i++) {
      const pos = PUMP_POSITIONS[i % PUMP_POSITIONS.length]!;
      insertPump.run(stationId, i + 1, `Pompa ${i + 1}`, JSON.stringify(["benzin", "motorin", "lpg"]), pos.x, pos.y);
    }

    const insertTank = db.prepare(
      "INSERT INTO fuel_tanks (station_id, fuel_type, capacity_liters, current_liters, low_stock_threshold_liters) VALUES (?, ?, ?, ?, ?)"
    );
    for (const t of DEFAULT_FUEL_TANKS) insertTank.run(stationId, t.fuelType, t.capacity, t.current, t.threshold);

    return stationId;
  });

  const stationId = create();

  recordAudit({
    user: req.user!,
    action: "station_created",
    entityType: "station",
    entityId: stationId,
    details: { slug: body.slug, name: body.name, pumpCount: body.pumpCount },
    ip: req.ip,
    stationId,
  });

  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(stationId)!;
  res.status(201).json({ station: serializeStation(station) });
});

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  address: z.string().max(300).optional(),
  active: z.boolean().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});

router.patch("/:id", requireRole("super_admin"), csrfProtection, validateBody(updateSchema), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(id);
  if (!existing) return void res.status(404).json({ error: "Istasyon bulunamadi." });

  const body = req.body as z.infer<typeof updateSchema>;
  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) { fields.push("name = ?"); values.push(body.name); }
  if (body.address !== undefined) { fields.push("address = ?"); values.push(body.address); }
  if (body.active !== undefined) { fields.push("active = ?"); values.push(body.active ? 1 : 0); }
  if (body.latitude !== undefined) { fields.push("latitude = ?"); values.push(body.latitude); }
  if (body.longitude !== undefined) { fields.push("longitude = ?"); values.push(body.longitude); }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE stations SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    recordAudit({ user: req.user!, action: "station_updated", entityType: "station", entityId: id, details: body, ip: req.ip, stationId: id });
  }

  const updated = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(id)!;
  res.json({ station: serializeStation(updated) });
});

router.delete("/:id", requireRole("super_admin"), csrfProtection, (req, res) => {
  const id = Number(req.params.id);
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(id);
  if (!station) return void res.status(404).json({ error: "Istasyon bulunamadi." });

  const txCount = (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE station_id = ?").get(id) as { c: number }).c;
  if (txCount > 0) {
    res.status(409).json({
      error: "Bu istasyonda islem kayitlari oldugu icin tamamen silinemez. Bunun yerine devre disi birakabilirsiniz.",
    });
    return;
  }

  const stationUsers = db.prepare<[number], UserRow>("SELECT * FROM users WHERE station_id = ?").all(id);

  const del = db.transaction(() => {
    db.prepare("DELETE FROM alarms WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM shifts WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM pumps WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM fuel_prices WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM fuel_stock_movements WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM fuel_tanks WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM settings WHERE station_id = ?").run(id);

    // Istasyona bagli kullanici hesaplarini da kalici olarak sil (islem kaydi
    // olmadigi icin bu hesaplarin baska bir istasyona tasinmasi anlamsiz).
    // Denetim gunlugundeki gecmis kayitlari koru, sadece kullaniciya olan referansi kaldir.
    if (stationUsers.length > 0) {
      const userIds = stationUsers.map((u) => u.id);
      const placeholders = userIds.map(() => "?").join(",");
      db.prepare(`UPDATE audit_log SET user_id = NULL WHERE user_id IN (${placeholders})`).run(...userIds);
      db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...userIds);
    }

    // Denetim gunlugundeki gecmis kayitlari koru, sadece bu istasyona olan referansi kaldir.
    db.prepare("UPDATE audit_log SET station_id = NULL WHERE station_id = ?").run(id);
    db.prepare("DELETE FROM stations WHERE id = ?").run(id);
  });
  del();

  recordAudit({
    user: req.user!,
    action: "station_deleted",
    entityType: "station",
    entityId: id,
    details: { slug: station.slug, name: station.name, deletedUsernames: stationUsers.map((u) => u.username) },
    ip: req.ip,
    stationId: null,
  });

  res.status(204).end();
});

export { router as stationsRouter };
